#include "bindings/bindings.h"

#import <UIKit/UIKit.h>
#import <WebKit/WebKit.h>
#import <objc/runtime.h>

// The web client's native bridge (docs/usage.md, "iOS app"). Everything here is
// installed on the WKWebView that wry creates: a document-start script that
// announces the capabilities, a haptics handler, and an edit-menu handler that
// puts the page's highlight actions in front of the system's text-selection menu.
static NSString *const TesseraBridgeScript =
	@"window.tesseraNative = { haptics: true, editMenu: true };"
	@"window.webkit.messageHandlers.tesseraEditMenu.postMessage({ mode: 'none' });";
static NSString *const TesseraHapticHandler = @"tesseraHaptic";
static NSString *const TesseraEditMenuHandler = @"tesseraEditMenu";
static NSString *const TesseraEditMenuIdentifier = @"dev.tessera.edit-menu.highlight";
static const CGFloat TesseraDotDiameter = 18;

static char TesseraBridgeKey;

static UIView *TesseraInputAccessoryView(id view, SEL selector) {
	return nil;
}

// "#rgb", "#rrggbb" or "#rrggbbaa". Anything else has no colour.
static UIColor *TesseraColorFromHex(NSString *hex) {
	if (![hex isKindOfClass:[NSString class]] || ![hex hasPrefix:@"#"]) {
		return nil;
	}
	NSString *digits = [hex substringFromIndex:1];
	if (digits.length == 3) {
		NSMutableString *expanded = [NSMutableString stringWithCapacity:6];
		for (NSUInteger i = 0; i < 3; i++) {
			NSString *digit = [digits substringWithRange:NSMakeRange(i, 1)];
			[expanded appendFormat:@"%@%@", digit, digit];
		}
		digits = expanded;
	}
	if (digits.length != 6 && digits.length != 8) {
		return nil;
	}
	unsigned long long value = 0;
	NSScanner *scanner = [NSScanner scannerWithString:digits];
	if (![scanner scanHexLongLong:&value] || !scanner.atEnd) {
		return nil;
	}
	if (digits.length == 6) {
		value = (value << 8) | 0xFF;
	}
	return [UIColor colorWithRed:((value >> 24) & 0xFF) / 255.0
						   green:((value >> 16) & 0xFF) / 255.0
							blue:((value >> 8) & 0xFF) / 255.0
						   alpha:(value & 0xFF) / 255.0];
}

// A filled circle with a hairline ring, so pale highlight colours still read
// on a light menu and dark ones on a dark menu. Always original: the menu
// must not tint it to the label colour. The drawing is cached per colour; each
// call returns its own instance because the VoiceOver label lives on the image.
static UIImage *TesseraDotImage(NSString *hex, NSString *label) {
	static NSMutableDictionary<NSString *, UIImage *> *cache;
	if (!cache) {
		cache = [NSMutableDictionary new];
	}
	UIImage *drawing = cache[hex];
	if (!drawing) {
		UIColor *color = TesseraColorFromHex(hex);
		if (!color) {
			return nil;
		}
		UIGraphicsImageRendererFormat *format = [UIGraphicsImageRendererFormat preferredFormat];
		format.opaque = NO;
		CGSize size = CGSizeMake(TesseraDotDiameter, TesseraDotDiameter);
		UIGraphicsImageRenderer *renderer = [[UIGraphicsImageRenderer alloc] initWithSize:size format:format];
		drawing = [renderer imageWithActions:^(UIGraphicsImageRendererContext *context) {
			CGFloat ring = 1.0 / format.scale;
			CGRect rect = CGRectInset(CGRectMake(0, 0, size.width, size.height), ring, ring);
			UIBezierPath *circle = [UIBezierPath bezierPathWithOvalInRect:rect];
			[color setFill];
			[circle fill];
			circle.lineWidth = ring;
			[[UIColor colorWithWhite:0.5 alpha:0.55] setStroke];
			[circle stroke];
		}];
		cache[hex] = drawing;
	}
	UIImage *image = [[UIImage imageWithCGImage:drawing.CGImage scale:drawing.scale orientation:UIImageOrientationUp]
		imageWithRenderingMode:UIImageRenderingModeAlwaysOriginal];
	image.accessibilityLabel = label;
	return image;
}

@interface TesseraNativeBridge : NSObject <WKScriptMessageHandler>
// Weak: the user content controller retains this handler, and the web view
// retains the controller, so a strong reference back would be a cycle.
@property(nonatomic, weak) WKWebView *webView;
// The page's latest { id, label, color? } actions; nil unless mode is 'highlight'.
@property(nonatomic, copy) NSArray<NSDictionary<NSString *, NSString *> *> *editActions;
@end

@implementation TesseraNativeBridge {
	UIImpactFeedbackGenerator *_light;
	UIImpactFeedbackGenerator *_medium;
	UISelectionFeedbackGenerator *_selection;
	UINotificationFeedbackGenerator *_notification;
}

// Registers the script and handlers on the configuration and returns the
// bridge; the caller points it at the web view once that exists.
+ (TesseraNativeBridge *)installOn:(WKWebViewConfiguration *)configuration {
	WKUserContentController *controller = configuration.userContentController;
	WKUserScript *script = [[WKUserScript alloc] initWithSource:TesseraBridgeScript
												  injectionTime:WKUserScriptInjectionTimeAtDocumentStart
											   forMainFrameOnly:YES];
	[controller addUserScript:script];
	TesseraNativeBridge *bridge = [TesseraNativeBridge new];
	// addScriptMessageHandler: throws when the name is taken, which a
	// configuration reused for a second web view would hit.
	[controller removeScriptMessageHandlerForName:TesseraHapticHandler];
	[controller removeScriptMessageHandlerForName:TesseraEditMenuHandler];
	[controller addScriptMessageHandler:bridge name:TesseraHapticHandler];
	[controller addScriptMessageHandler:bridge name:TesseraEditMenuHandler];
	return bridge;
}

+ (instancetype)bridgeForView:(UIView *)view {
	for (UIView *ancestor = view; ancestor; ancestor = ancestor.superview) {
		if ([ancestor isKindOfClass:[WKWebView class]]) {
			return objc_getAssociatedObject(ancestor, &TesseraBridgeKey);
		}
	}
	return nil;
}

- (void)userContentController:(WKUserContentController *)controller
	didReceiveScriptMessage:(WKScriptMessage *)message {
	if (!message.frameInfo.isMainFrame) {
		return;
	}
	if ([message.name isEqualToString:TesseraHapticHandler]) {
		[self playHaptic:message.body];
	} else if ([message.name isEqualToString:TesseraEditMenuHandler]) {
		[self updateEditMenu:message.body];
	}
}

- (void)playHaptic:(id)kind {
	if (![kind isKindOfClass:[NSString class]]) {
		return;
	}
	UIFeedbackGenerator *generator = nil;
	if ([kind isEqualToString:@"light"]) {
		generator = _light ?: (_light = [self impactGeneratorWithStyle:UIImpactFeedbackStyleLight]);
		[_light impactOccurred];
	} else if ([kind isEqualToString:@"medium"]) {
		generator = _medium ?: (_medium = [self impactGeneratorWithStyle:UIImpactFeedbackStyleMedium]);
		[_medium impactOccurred];
	} else if ([kind isEqualToString:@"selection"]) {
		generator = _selection ?: (_selection = [self selectionGenerator]);
		[_selection selectionChanged];
	} else if ([kind isEqualToString:@"success"] || [kind isEqualToString:@"warning"]) {
		generator = _notification ?: (_notification = [self notificationGenerator]);
		[_notification notificationOccurred:[kind isEqualToString:@"success"]
			? UINotificationFeedbackTypeSuccess : UINotificationFeedbackTypeWarning];
	}
	// Keep the Taptic Engine warm for the next one.
	[generator prepare];
}

- (UIImpactFeedbackGenerator *)impactGeneratorWithStyle:(UIImpactFeedbackStyle)style {
	UIView *view = self.webView;
	if (@available(iOS 17.5, *)) {
		if (view) {
			return [UIImpactFeedbackGenerator feedbackGeneratorWithStyle:style forView:view];
		}
	}
	return [[UIImpactFeedbackGenerator alloc] initWithStyle:style];
}

- (UISelectionFeedbackGenerator *)selectionGenerator {
	UIView *view = self.webView;
	if (@available(iOS 17.5, *)) {
		if (view) {
			return [UISelectionFeedbackGenerator feedbackGeneratorForView:view];
		}
	}
	return [UISelectionFeedbackGenerator new];
}

- (UINotificationFeedbackGenerator *)notificationGenerator {
	UIView *view = self.webView;
	if (@available(iOS 17.5, *)) {
		if (view) {
			return [UINotificationFeedbackGenerator feedbackGeneratorForView:view];
		}
	}
	return [UINotificationFeedbackGenerator new];
}

- (void)updateEditMenu:(id)body {
	NSMutableArray<NSDictionary<NSString *, NSString *> *> *actions = nil;
	NSDictionary *state = [body isKindOfClass:[NSDictionary class]] ? body : nil;
	if ([state[@"mode"] isEqual:@"highlight"] && [state[@"actions"] isKindOfClass:[NSArray class]]) {
		actions = [NSMutableArray new];
		for (id entry in state[@"actions"]) {
			NSString *identifier = [entry isKindOfClass:[NSDictionary class]] ? entry[@"id"] : nil;
			NSString *label = [entry isKindOfClass:[NSDictionary class]] ? entry[@"label"] : nil;
			if (![identifier isKindOfClass:[NSString class]] || ![label isKindOfClass:[NSString class]]) {
				continue;
			}
			NSString *color = entry[@"color"];
			if ([color isKindOfClass:[NSString class]] && TesseraColorFromHex(color)) {
				[actions addObject:@{@"id": identifier, @"label": label, @"color": color}];
			} else {
				[actions addObject:@{@"id": identifier, @"label": label}];
			}
		}
		if (actions.count == 0) {
			actions = nil;
		}
	}
	if ((actions || self.editActions) && ![actions isEqual:self.editActions]) {
		self.editActions = actions;
		// A menu that is already built keeps its items; the next one is rebuilt.
		[[UIMenuSystem contextSystem] setNeedsRebuild];
	}
}

- (UIMenu *)highlightMenu {
	NSArray<NSDictionary<NSString *, NSString *> *> *actions = self.editActions;
	if (!actions) {
		return nil;
	}
	__weak WKWebView *webView = self.webView;
	NSMutableArray<UIMenuElement *> *children = [NSMutableArray arrayWithCapacity:actions.count];
	for (NSDictionary<NSString *, NSString *> *action in actions) {
		NSString *identifier = action[@"id"];
		NSString *label = action[@"label"];
		UIImage *dot = action[@"color"] ? TesseraDotImage(action[@"color"], label) : nil;
		// The menu bar shows a colour action's image in place of its title, so
		// the title stays empty and the label rides on the image for VoiceOver.
		UIAction *item = [UIAction actionWithTitle:dot ? @"" : label
											 image:dot
										identifier:nil
										   handler:^(__kindof UIAction *tapped) {
			NSData *json = [NSJSONSerialization dataWithJSONObject:@{@"id": identifier} options:0 error:nil];
			NSString *detail = [[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding];
			NSString *script = [NSString stringWithFormat:
				@"window.dispatchEvent(new CustomEvent('tessera:edit-menu', { detail: %@ }))", detail];
			[webView evaluateJavaScript:script completionHandler:nil];
		}];
		if (dot) {
			// The overflow list beside the bar has room for a name next to the dot.
			item.subtitle = label;
		}
		[children addObject:item];
	}
	return [UIMenu menuWithTitle:@"" image:nil identifier:TesseraEditMenuIdentifier
						 options:UIMenuOptionsDisplayInline children:children];
}
@end

typedef void (*TesseraBuildMenuFunction)(id, SEL, id<UIMenuBuilder>);
static TesseraBuildMenuFunction TesseraBuildMenuOriginal;

// WKContentView's -buildMenuWithBuilder: composes the text-selection menu from
// the context menu system. Ours goes first so it leads the menu and the
// system's own items (Copy, Look Up, Translate, Share) follow behind the arrow.
static void TesseraBuildMenu(UIView *contentView, SEL selector, id<UIMenuBuilder> builder) {
	TesseraBuildMenuOriginal(contentView, selector, builder);
	if (builder.system != [UIMenuSystem contextSystem]) {
		return;
	}
	UIMenu *menu = [[TesseraNativeBridge bridgeForView:contentView] highlightMenu];
	if (menu) {
		[builder insertChildMenu:menu atStartOfMenuForIdentifier:UIMenuRoot];
	}
}

@interface TesseraScrollDelegate : NSObject <UIScrollViewDelegate>
@property(nonatomic, weak) WKWebView *webView;
@property(nonatomic, weak) id<UIScrollViewDelegate> originalDelegate;
@end

@implementation TesseraScrollDelegate
- (BOOL)scrollViewShouldScrollToTop:(UIScrollView *)scrollView {
	[self.webView evaluateJavaScript:@"window.dispatchEvent(new CustomEvent('tessera:status-bar-tap'))"
		completionHandler:nil];
	// The page owns its nested pane's scroll, not the outer web document.
	return NO;
}

- (BOOL)respondsToSelector:(SEL)selector {
	return [super respondsToSelector:selector] || [self.originalDelegate respondsToSelector:selector];
}

- (id)forwardingTargetForSelector:(SEL)selector {
	id original = self.originalDelegate;
	return [original respondsToSelector:selector] ? original : [super forwardingTargetForSelector:selector];
}
@end

static char TesseraScrollDelegateKey;

@interface WKWebView (TesseraKeyboard)
@end

@implementation WKWebView (TesseraKeyboard)
+ (void)load {
	// WKContentView is loaded lazily. Wait until WebKit has created its content
	// view, but replace the form toolbar before any editor can take focus.
	Method original = class_getInstanceMethod(self, @selector(initWithFrame:configuration:));
	Method replacement = class_getInstanceMethod(self, @selector(initTesseraWithFrame:configuration:));
	method_exchangeImplementations(original, replacement);
}

- (instancetype)initTesseraWithFrame:(CGRect)frame configuration:(WKWebViewConfiguration *)configuration {
	// The scripts and handlers go in before WebKit copies the configuration, so
	// the very first document already sees window.tesseraNative.
	TesseraNativeBridge *bridge = [TesseraNativeBridge installOn:configuration];
	self = [self initTesseraWithFrame:frame configuration:configuration];
	if (self) {
		bridge.webView = self;
		objc_setAssociatedObject(self, &TesseraBridgeKey, bridge, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
		// The caret and selection handles take the web view's tint: gilt, the
		// app's --accent (tokens.css), instead of the system blue.
		self.tintColor = [UIColor colorWithDynamicProvider:^UIColor *(UITraitCollection *traits) {
			return traits.userInterfaceStyle == UIUserInterfaceStyleDark
				? [UIColor colorWithRed:0xd8 / 255.0 green:0xaa / 255.0 blue:0x55 / 255.0 alpha:1]
				: [UIColor colorWithRed:0x93 / 255.0 green:0x65 / 255.0 blue:0x0f / 255.0 alpha:1];
		}];

		Class contentView = NSClassFromString(@"WKContentView");
		Method accessory = class_getInstanceMethod(contentView, @selector(inputAccessoryView));
		if (accessory) {
			// Replace only WKContentView's accessory, not UIResponder's keyboard
			// or the scanner's native views. The web editor supplies its own bar.
			class_replaceMethod(contentView, @selector(inputAccessoryView),
				(IMP)TesseraInputAccessoryView, method_getTypeEncoding(accessory));
		}

		static dispatch_once_t menuOnce;
		dispatch_once(&menuOnce, ^{
			Method build = class_getInstanceMethod(contentView, @selector(buildMenuWithBuilder:));
			if (build) {
				// The original may be WKContentView's own or UIResponder's; calling
				// it with the content view as self is the same as calling super.
				TesseraBuildMenuOriginal = (TesseraBuildMenuFunction)method_getImplementation(build);
				class_replaceMethod(contentView, @selector(buildMenuWithBuilder:),
					(IMP)TesseraBuildMenu, method_getTypeEncoding(build));
			}
		});

		TesseraScrollDelegate *delegate = [TesseraScrollDelegate new];
		delegate.webView = self;
		delegate.originalDelegate = self.scrollView.delegate;
		objc_setAssociatedObject(self, &TesseraScrollDelegateKey, delegate, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
		self.scrollView.delegate = delegate;
		self.scrollView.scrollsToTop = YES;
	}
	return self;
}
@end

int main(int argc, char * argv[]) {
	ffi::start_app();
	return 0;
}
