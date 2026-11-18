#import <AppKit/AppKit.h>
#import <sys/types.h>

@interface CaptureSnapWindow : NSObject
@property(nonatomic, readonly) pid_t pid;
@property(nonatomic, readonly) CGRect frame;
- (instancetype)initWithPID:(pid_t)pid frame:(CGRect)frame;
@end

extern NSNotificationName const CaptureSnapTargetsDidChange;

@interface CaptureSnapTargets : NSObject
@property(nonatomic, copy) NSArray<CaptureSnapWindow *> *windows;
@property(nonatomic, readonly) BOOL elementMode;
@property(nonatomic, readonly) BOOL accessibilityTrusted;
- (void)toggleElementMode;
@end

NSArray<CaptureSnapWindow *> *captureOnscreenWindows(void);
CaptureSnapWindow *captureSnapWindowAtPoint(NSArray<CaptureSnapWindow *> *windows, CGPoint point);
NSRect localSnapRect(CGRect target, CGRect display, NSSize localSize);
NSArray<NSValue *> *captureElementRects(CaptureSnapWindow *window, CGPoint point);
