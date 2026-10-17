//! AppKit entry points not exposed by Tauri: Dock actions and text Services.
//! Keep Tauri's application delegate intact; add only its missing Dock selector.
#![allow(unsafe_code)]
#![deny(unsafe_op_in_unsafe_fn)]

use std::cell::OnceCell;

use objc2::rc::Retained;
use objc2::runtime::{AnyClass, AnyObject, Imp, Sel};
use objc2::{DefinedClass, MainThreadMarker, MainThreadOnly, define_class, msg_send, sel};
use objc2_app_kit::{NSApplication, NSMenu, NSMenuItem, NSPasteboard};
use objc2_foundation::{NSObject, NSObjectProtocol, NSString, ns_string};
use tauri::AppHandle;

use crate::{app, capture};

struct NativeEntries {
    // Menu targets and NSApplication's services provider must outlive their use.
    provider: Retained<ServiceProvider>,
    dock: Retained<NSMenu>,
}

thread_local! {
    static ENTRIES: OnceCell<NativeEntries> = const { OnceCell::new() };
}

define_class!(
    // SAFETY: NSObject has no subclassing requirements. Instances are confined
    // to AppKit's main thread, and the class has no custom Drop implementation.
    #[unsafe(super = NSObject)]
    #[thread_kind = MainThreadOnly]
    #[ivars = AppHandle]
    struct ServiceProvider;

    // SAFETY: NSObjectProtocol has no additional implementation requirements.
    unsafe impl NSObjectProtocol for ServiceProvider {}

    impl ServiceProvider {
        // SAFETY: These action selectors have AppKit's void(id sender) signature.
        #[unsafe(method(addToToday:))]
        fn add_to_today(&self, _sender: Option<&AnyObject>) {
            capture::in_main(self.ivars());
        }

        // SAFETY: AppKit action signature is void(id sender).
        #[unsafe(method(newPage:))]
        fn new_page(&self, _sender: Option<&AnyObject>) {
            app::command(self.ivars(), "shell.new");
        }

        // SAFETY: AppKit action signature is void(id sender).
        #[unsafe(method(newQuestion:))]
        fn new_question(&self, _sender: Option<&AnyObject>) {
            app::command(self.ivars(), "create.question");
        }

        // SAFETY: Services calls this on the main thread with the documented
        // void(NSPasteboard *, NSString *, NSString **) signature. The optional
        // error pointer, when non-null, is writable for the duration of the call.
        #[unsafe(method(sendToTessera:userData:error:))]
        fn send_to_tessera(
            &self,
            pasteboard: &NSPasteboard,
            _user_data: Option<&NSString>,
            error: *mut *mut NSString,
        ) {
            let Some(text) = pasteboard.stringForType(ns_string!("public.utf8-plain-text")) else {
                return;
            };
            if let Err(detail) = capture::from_service(self.ivars(), text.to_string()) {
                app::log(&format!("cannot open service capture: {detail}"));
                if !error.is_null() {
                    // SAFETY: AppKit supplied this writable out pointer. An
                    // autoreleased NSString follows the Services +0 convention.
                    unsafe {
                        *error = Retained::autorelease_ptr(NSString::from_str("Could not open capture."));
                    }
                }
            }
        }
    }
);

impl ServiceProvider {
    fn new(app: AppHandle, mtm: MainThreadMarker) -> Retained<Self> {
        let this = Self::alloc(mtm).set_ivars(app);
        // SAFETY: NSObject's init takes no arguments and returns this instance.
        unsafe { msg_send![super(this), init] }
    }
}

pub fn register(app: &AppHandle) {
    let mtm = MainThreadMarker::new().expect("AppKit entry points register on the main thread");
    let native_app = NSApplication::sharedApplication(mtm);
    ENTRIES.with(|entries| {
        let entries = entries.get_or_init(|| {
            let provider = ServiceProvider::new(app.clone(), mtm);
            let dock = NSMenu::new(mtm);
            dock.setAutoenablesItems(false);
            for (title, selector) in [
                ("Add to Today", sel!(addToToday:)),
                ("New Page", sel!(newPage:)),
                ("New Question", sel!(newQuestion:)),
            ] {
                // SAFETY: Each selector is a void(id) action defined above on
                // this provider. Both target and menu are retained in ENTRIES
                // on the main thread for the application's lifetime.
                let item = unsafe {
                    let item = NSMenuItem::initWithTitle_action_keyEquivalent(
                        NSMenuItem::alloc(mtm),
                        &NSString::from_str(title),
                        Some(selector),
                        ns_string!(""),
                    );
                    item.setTarget(Some(&provider));
                    item
                };
                dock.addItem(&item);
            }
            NativeEntries { provider, dock }
        });
        // SAFETY: The retained provider implements precisely the selector
        // declared by NSServices in Info.plist and lives on the main thread.
        unsafe { native_app.setServicesProvider(Some(&entries.provider)) };
    });
    install_dock_menu(&native_app);
}

fn install_dock_menu(app: &NSApplication) {
    let Some(delegate) = app.delegate() else {
        app::log("cannot install Dock menu without an application delegate");
        return;
    };
    let delegate: &AnyObject = delegate.as_ref();
    let class = delegate.class();
    let selector = sel!(applicationDockMenu:);
    // Never replace Tauri's delegate or any existing/inherited implementation.
    if class.instance_method(selector).is_some() {
        app::log("application delegate already provides a Dock menu");
        return;
    }
    // SAFETY: AppKit calls applicationDockMenu: on the main thread with the
    // signature NSMenu *(id, SEL, NSApplication *), encoded as @@:@. Erasing
    // that function signature to IMP is required by class_addMethod. Only an
    // absent selector is added; Tauri's existing methods and ivars are untouched.
    let added = unsafe {
        let implementation = std::mem::transmute::<
            extern "C-unwind" fn(&AnyObject, Sel, &NSApplication) -> *mut NSMenu,
            Imp,
        >(dock_menu);
        objc2::ffi::class_addMethod(
            (class as *const AnyClass).cast_mut(),
            selector,
            implementation,
            c"@@:@".as_ptr(),
        )
    };
    if !added.as_bool() {
        app::log("cannot add applicationDockMenu: to the application delegate");
    }
}

extern "C-unwind" fn dock_menu(
    _delegate: &AnyObject,
    _selector: Sel,
    _app: &NSApplication,
) -> *mut NSMenu {
    // AppKit requests a +0 object. ENTRIES retains it for the app's lifetime;
    // no object from Tauri's delegate is cast to our provider type.
    ENTRIES.with(|entries| {
        entries.get().map_or(std::ptr::null_mut(), |entries| {
            Retained::as_ptr(&entries.dock).cast_mut()
        })
    })
}
