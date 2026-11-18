#import "snap-targets.h"
#import <ApplicationServices/ApplicationServices.h>
#import <unistd.h>

NSNotificationName const CaptureSnapTargetsDidChange = @"CaptureSnapTargetsDidChange";

@implementation CaptureSnapWindow

- (instancetype)initWithPID:(pid_t)pid frame:(CGRect)frame {
    self = [super init];
    if (self) {
        _pid = pid;
        _frame = frame;
    }
    return self;
}
@end

@implementation CaptureSnapTargets {
    BOOL _prompted;
}

- (instancetype)init {
    self = [super init];
    if (self) {
        _accessibilityTrusted = AXIsProcessTrusted();
        _elementMode = _accessibilityTrusted;
    }
    return self;
}

- (void)targetsDidChange {
    [NSNotificationCenter.defaultCenter postNotificationName:CaptureSnapTargetsDidChange object:self];
}

- (void)setWindows:(NSArray<CaptureSnapWindow *> *)windows {
    _windows = [windows copy];
    [self targetsDidChange];
}

- (void)toggleElementMode {
    _elementMode = !_elementMode;
    if (_elementMode) {
        _accessibilityTrusted = AXIsProcessTrusted();
    }
    [self targetsDidChange];
    if (_elementMode && !_accessibilityTrusted && !_prompted) {
        _prompted = YES;
        NSDictionary *options = @{(__bridge NSString *)kAXTrustedCheckOptionPrompt: @YES};
        AXIsProcessTrustedWithOptions((__bridge CFDictionaryRef)options);
    }
}
@end

static BOOL usableRect(CGRect rect) {
    return isfinite(rect.origin.x) && isfinite(rect.origin.y) &&
           isfinite(rect.size.width) && isfinite(rect.size.height) &&
           rect.size.width >= 2 && rect.size.height >= 2;
}

NSArray<CaptureSnapWindow *> *captureOnscreenWindows(void) {
    NSArray<NSDictionary *> *entries = CFBridgingRelease(CGWindowListCopyWindowInfo(
        kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements, kCGNullWindowID));
    NSMutableArray<CaptureSnapWindow *> *windows = [NSMutableArray array];
    NSInteger modalLayer = CGWindowLevelForKey(kCGModalPanelWindowLevelKey);
    for (NSDictionary *entry in entries) {
        pid_t pid = [entry[(__bridge NSString *)kCGWindowOwnerPID] intValue];
        NSInteger layer = [entry[(__bridge NSString *)kCGWindowLayer] integerValue];
        NSDictionary *bounds = entry[(__bridge NSString *)kCGWindowBounds];
        CGRect frame;
        if (pid <= 0 || pid == getpid() || layer < 0 || layer > modalLayer ||
            [entry[(__bridge NSString *)kCGWindowAlpha] doubleValue] <= 0 ||
            bounds == nil || !CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)bounds, &frame) ||
            !usableRect(frame)) {
            continue;
        }
        [windows addObject:[[CaptureSnapWindow alloc] initWithPID:pid frame:frame]];
    }
    return windows;
}

CaptureSnapWindow *captureSnapWindowAtPoint(NSArray<CaptureSnapWindow *> *windows, CGPoint point) {
    for (CaptureSnapWindow *window in windows) {
        if (CGRectContainsPoint(window.frame, point)) {
            return window;
        }
    }
    return nil;
}

NSRect localSnapRect(CGRect target, CGRect display, NSSize localSize) {
    CGRect clipped = CGRectIntersection(target, display);
    if (!usableRect(display) || !usableRect(clipped) || localSize.width <= 0 || localSize.height <= 0) {
        return NSZeroRect;
    }
    CGFloat scaleX = localSize.width / display.size.width;
    CGFloat scaleY = localSize.height / display.size.height;
    return NSMakeRect((clipped.origin.x - display.origin.x) * scaleX,
                      (clipped.origin.y - display.origin.y) * scaleY,
                      clipped.size.width * scaleX, clipped.size.height * scaleY);
}

static BOOL readAXValue(CFTypeRef value, AXValueType type, void *destination) {
    return value != NULL && CFGetTypeID(value) == AXValueGetTypeID() &&
           AXValueGetValue((AXValueRef)value, type, destination);
}

NSArray<NSValue *> *captureElementRects(CaptureSnapWindow *window, CGPoint point) {
    AXUIElementRef app = AXUIElementCreateApplication(window.pid);
    AXUIElementSetMessagingTimeout(app, 0.15f);
    AXUIElementRef element = NULL;
    AXError error = AXUIElementCopyElementAtPosition(app, (float)point.x, (float)point.y, &element);
    CFRelease(app);
    if (error != kAXErrorSuccess || element == NULL) {
        if (element != NULL) {
            CFRelease(element);
        }
        return @[];
    }

    NSArray *attributes = @[(__bridge NSString *)kAXPositionAttribute, (__bridge NSString *)kAXSizeAttribute,
                            (__bridge NSString *)kAXParentAttribute];
    NSMutableArray<NSValue *> *rects = [NSMutableArray array];
    // Read only geometry and the immediate parent. Bound both IPC and ancestry traversal.
    for (NSUInteger depth = 0; depth < 6 && element != NULL; depth++) {
        pid_t pid = 0;
        if (AXUIElementGetPid(element, &pid) != kAXErrorSuccess || pid != window.pid) {
            break;
        }
        AXUIElementSetMessagingTimeout(element, 0.08f);
        CFArrayRef values = NULL;
        error = AXUIElementCopyMultipleAttributeValues(element, (__bridge CFArrayRef)attributes, 0, &values);
        if (error != kAXErrorSuccess || values == NULL || CFArrayGetCount(values) != 3) {
            if (values != NULL) {
                CFRelease(values);
            }
            break;
        }

        CGPoint origin;
        CGSize size;
        if (readAXValue(CFArrayGetValueAtIndex(values, 0), kAXValueCGPointType, &origin) &&
            readAXValue(CFArrayGetValueAtIndex(values, 1), kAXValueCGSizeType, &size)) {
            CGRect frame = (CGRect){origin, size};
            CGRect target = CGRectIntersection(frame, window.frame);
            if (usableRect(frame) && usableRect(target) && CGRectContainsPoint(target, point) &&
                !CGRectEqualToRect(target, window.frame)) {
                NSValue *candidate = [NSValue valueWithRect:target];
                if (![rects containsObject:candidate]) {
                    [rects addObject:candidate];
                }
            }
        }
        CFTypeRef parent = CFArrayGetValueAtIndex(values, 2);
        AXUIElementRef next = NULL;
        if (parent != NULL && CFGetTypeID(parent) == AXUIElementGetTypeID() && !CFEqual(parent, element)) {
            next = (AXUIElementRef)CFRetain(parent);
        }
        CFRelease(values);
        CFRelease(element);
        element = next;
    }
    if (element != NULL) {
        CFRelease(element);
    }
    return rects;
}
