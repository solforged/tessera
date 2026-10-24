#include "bindings/bindings.h"

#import <UIKit/UIKit.h>
#import <WebKit/WebKit.h>
#import <objc/runtime.h>

static UIView *TesseraInputAccessoryView(id view, SEL selector) {
	return nil;
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
	self = [self initTesseraWithFrame:frame configuration:configuration];
	if (self) {
		Class contentView = NSClassFromString(@"WKContentView");
		Method accessory = class_getInstanceMethod(contentView, @selector(inputAccessoryView));
		if (accessory) {
			// Replace only WKContentView's accessory, not UIResponder's keyboard
			// or the scanner's native views. The web editor supplies its own bar.
			class_replaceMethod(contentView, @selector(inputAccessoryView),
				(IMP)TesseraInputAccessoryView, method_getTypeEncoding(accessory));
		}

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
