#import <AppKit/AppKit.h>
#import "selection-view.h"
#import <ScreenCaptureKit/ScreenCaptureKit.h>
#import <UniformTypeIdentifiers/UniformTypeIdentifiers.h>
#import <unistd.h>

typedef NS_ENUM(int, CaptureExit) {
    CaptureOK = 0,
    CaptureCancelled = 2,
    CaptureUnsupported = 3,
    CapturePermissionDenied = 4,
    CaptureUnavailable = 5,
    CaptureOutputFailed = 6,
    CaptureTooLarge = 7,
    CaptureHandoff = 8,
};

static const size_t maxPixelsPerDisplay = 32000000;
static const size_t maxSnapshotPixels = 96000000;

@interface CapturePanel : NSPanel
@end

@implementation CapturePanel
- (BOOL)canBecomeKeyWindow { return YES; }
@end

static CGDirectDisplayID screenID(NSScreen *screen) {
    return [screen.deviceDescription[@"NSScreenNumber"] unsignedIntValue];
}

@interface DisplaySnapshot : NSObject
@property(readonly) CGDirectDisplayID displayID;
@property(readonly) NSRect frame;
@property(readonly) CGFloat scale;
@property(readonly) CGImageRef image;
- (instancetype)initWithScreen:(NSScreen *)screen;
- (void)storeImage:(CGImageRef)image;
@end

@implementation DisplaySnapshot
- (instancetype)initWithScreen:(NSScreen *)screen {
    self = [super init];
    if (self) {
        _displayID = screenID(screen);
        _frame = screen.frame;
        _scale = screen.backingScaleFactor;
    }
    return self;
}

- (void)storeImage:(CGImageRef)image {
    if (_image != NULL) {
        CGImageRelease(_image);
    }
    _image = image == NULL ? NULL : CGImageRetain(image);
}

- (void)dealloc {
    if (_image != NULL) {
        CGImageRelease(_image);
    }
}
@end

static BOOL screensMatch(NSDictionary<NSNumber *, DisplaySnapshot *> *snapshots, NSArray<NSScreen *> *screens) {
    if (snapshots.count != screens.count) {
        return NO;
    }
    for (NSScreen *screen in screens) {
        DisplaySnapshot *snapshot = snapshots[@(screenID(screen))];
        if (snapshot == nil || !NSEqualRects(snapshot.frame, screen.frame) ||
            snapshot.scale != screen.backingScaleFactor) {
            return NO;
        }
    }
    return YES;
}

static void hidePanels(NSArray<CapturePanel *> *panels) {
    for (CapturePanel *panel in panels) {
        [panel orderOut:nil];
    }
}

API_AVAILABLE(macos(14.0))
static void showSelection(NSDictionary<NSNumber *, DisplaySnapshot *> *snapshots, NSURL *output, BOOL allowOCR) {
    NSArray<NSScreen *> *screens = NSScreen.screens;
    if (!screensMatch(snapshots, screens)) {
        exit(CaptureCancelled);
    }

    NSMutableArray<CapturePanel *> *panels = [NSMutableArray arrayWithCapacity:screens.count];
    __weak NSArray<CapturePanel *> *weakPanels = panels;
    __block BOOL saving = NO;
    CapturePanel *keyPanel = nil;
    NSPoint cursor = NSEvent.mouseLocation;
    for (NSScreen *screen in screens) {
        DisplaySnapshot *snapshot = snapshots[@(screenID(screen))];
        NSRect frame = snapshot.frame;
        CapturePanel *panel = [[CapturePanel alloc] initWithContentRect:frame
                                                            styleMask:NSWindowStyleMaskBorderless |
                                                                      NSWindowStyleMaskNonactivatingPanel
                                                              backing:NSBackingStoreBuffered
                                                                defer:NO screen:nil];
        [panel setFrame:frame display:NO];
        panel.level = NSScreenSaverWindowLevel;
        panel.collectionBehavior = NSWindowCollectionBehaviorCanJoinAllSpaces |
                                   NSWindowCollectionBehaviorFullScreenAuxiliary;
        panel.hasShadow = NO;
        panel.animationBehavior = NSWindowAnimationBehaviorNone;
        panel.hidesOnDeactivate = NO;
        panel.becomesKeyOnlyIfNeeded = NO;
        panel.contentView = [[SelectionView alloc] initWithFrame:(NSRect){NSZeroPoint, frame.size}
            image:snapshot.image allowOCR:allowOCR begin:^(SelectionView *active) {
                [active.window makeKeyWindow];
                for (CapturePanel *other in weakPanels) {
                    SelectionView *view = (SelectionView *)other.contentView;
                    if (view != active) {
                        [view clearSelection];
                    }
                }
            } output:^NSString *(CaptureDestination destination, NSData *png, NSWindow *owner) {
                switch (destination) {
                    case DestinationCancel:
                        hidePanels(weakPanels);
                        exit(CaptureCancelled);
                    case DestinationCopy: {
                        NSPasteboardItem *item = [NSPasteboardItem new];
                        if (![item setData:png forType:NSPasteboardTypePNG]) {
                            return @"无法准备剪贴板图片";
                        }
                        NSPasteboard *board = NSPasteboard.generalPasteboard;
                        [board clearContents];
                        if (![board writeObjects:@[item]]) {
                            return @"复制失败，请重试";
                        }
                        break;
                    }
                    case DestinationSave: {
                        saving = YES;
                        hidePanels(weakPanels);
                        [NSApp activate];
                        NSSavePanel *dialog = NSSavePanel.savePanel;
                        dialog.allowedContentTypes = @[UTTypePNG];
                        dialog.nameFieldStringValue = @"截图.png";
                        BOOL confirmed = [dialog runModal] == NSModalResponseOK;
                        if (confirmed && [png writeToURL:dialog.URL options:NSDataWritingAtomic error:NULL]) {
                            exit(CaptureOK);
                        }
                        [NSApp activate];
                        for (CapturePanel *overlay in weakPanels) {
                            [overlay orderFrontRegardless];
                        }
                        [owner makeKeyAndOrderFront:nil];
                        saving = NO;
                        return confirmed ? @"无法保存 PNG，请重试" : nil;
                    }
                    case DestinationOCR:
                        if (!allowOCR) {
                            return @"OCR 插件尚未启用";
                        }
                        if (![png writeToURL:output options:0 error:NULL]) {
                            return @"无法准备 OCR 图片，请重试";
                        }
                        hidePanels(weakPanels);
                        exit(CaptureHandoff);
                }
                hidePanels(weakPanels);
                exit(CaptureOK);
            }];
        [panel makeFirstResponder:panel.contentView];
        [panels addObject:panel];
        if (NSPointInRect(cursor, frame)) {
            keyPanel = panel;
        }
    }

    // Retain the panels for the session. Switching the key panel within
    // the helper is expected when the user chooses a different display.
    void (^cancel)(NSNotification *) = ^(__unused NSNotification *note) {
        hidePanels(panels);
        exit(CaptureCancelled);
    };
    [NSNotificationCenter.defaultCenter addObserverForName:NSApplicationDidChangeScreenParametersNotification
                                                    object:NSApp queue:nil usingBlock:cancel];

    CapturePanel *first = keyPanel ?: panels.firstObject;
    for (CapturePanel *panel in panels) {
        if (panel != first) {
            [panel orderFrontRegardless];
        }
    }
    [first makeKeyAndOrderFront:nil];
    [NSNotificationCenter.defaultCenter addObserverForName:NSWindowDidResignKeyNotification
                                                    object:nil queue:nil usingBlock:^(NSNotification *note) {
        if (![panels containsObject:note.object]) {
            return;
        }
        dispatch_async(dispatch_get_main_queue(), ^{
            id key = NSApp.keyWindow;
            if (!saving && (key == nil || ![panels containsObject:key])) {
                cancel(note);
            }
        });
    }];
}

API_AVAILABLE(macos(14.0))
static void captureDisplays(SCShareableContent *content, NSDictionary<NSNumber *, DisplaySnapshot *> *snapshots,
                            NSURL *output, BOOL allowOCR) {
    dispatch_group_t pending = dispatch_group_create();
    size_t pixelsRemaining = maxSnapshotPixels;
    NSUInteger started = 0;
    for (SCDisplay *display in content.displays) {
        DisplaySnapshot *snapshot = snapshots[@(display.displayID)];
        if (snapshot == nil) {
            continue;
        }
        SCContentFilter *filter = [[SCContentFilter alloc] initWithDisplay:display excludingWindows:@[]];
        SCStreamConfiguration *configuration = [[SCStreamConfiguration alloc] init];
        configuration.width = (size_t)lround(NSWidth(snapshot.frame) * filter.pointPixelScale);
        configuration.height = (size_t)lround(NSHeight(snapshot.frame) * filter.pointPixelScale);
        configuration.showsCursor = NO;
        size_t pixels = configuration.width * configuration.height;
        if (pixels == 0 || pixels > maxPixelsPerDisplay || pixels > pixelsRemaining) {
            exit(CaptureTooLarge);
        }
        pixelsRemaining -= pixels;
        started++;
        dispatch_group_enter(pending);
        [SCScreenshotManager captureImageWithFilter:filter configuration:configuration
            completionHandler:^(CGImageRef image, NSError *error) {
                if (image == NULL || error != nil) {
                    exit(CaptureUnavailable);
                }
                [snapshot storeImage:image];
                dispatch_group_leave(pending);
            }];
    }
    if (started != snapshots.count) {
        exit(CaptureUnavailable);
    }
    dispatch_group_notify(pending, dispatch_get_main_queue(), ^{ showSelection(snapshots, output, allowOCR); });
}

API_AVAILABLE(macos(14.0))
static void captureWithFilters(NSDictionary<NSNumber *, DisplaySnapshot *> *snapshots, NSURL *output, BOOL allowOCR) {
    for (DisplaySnapshot *snapshot in snapshots.objectEnumerator) {
        [snapshot storeImage:NULL];
    }
    [SCShareableContent getShareableContentExcludingDesktopWindows:NO onScreenWindowsOnly:YES
        completionHandler:^(SCShareableContent *content, NSError *error) {
            if (content == nil || error != nil) {
                exit(CaptureUnavailable);
            }
            captureDisplays(content, snapshots, output, allowOCR);
        }];
}

#if __MAC_OS_X_VERSION_MAX_ALLOWED >= 150200
API_AVAILABLE(macos(15.2))
static void captureDisplayRects(NSDictionary<NSNumber *, DisplaySnapshot *> *snapshots, NSURL *output, BOOL allowOCR) {
    size_t remaining = maxSnapshotPixels;
    for (DisplaySnapshot *snapshot in snapshots.objectEnumerator) {
        CGRect bounds = CGDisplayBounds(snapshot.displayID);
        size_t width = (size_t)lround(NSWidth(snapshot.frame) * snapshot.scale);
        size_t height = (size_t)lround(NSHeight(snapshot.frame) * snapshot.scale);
        size_t pixels = width * height;
        if (!NSEqualSizes(bounds.size, snapshot.frame.size) || pixels == 0 || pixels > maxPixelsPerDisplay ||
            pixels > remaining) {
            captureWithFilters(snapshots, output, allowOCR);
            return;
        }
        remaining -= pixels;
    }

    dispatch_group_t pending = dispatch_group_create();
    for (DisplaySnapshot *snapshot in snapshots.objectEnumerator) {
        dispatch_group_enter(pending);
        [SCScreenshotManager captureImageInRect:CGDisplayBounds(snapshot.displayID)
            completionHandler:^(CGImageRef image, NSError *error) {
                size_t width = (size_t)lround(NSWidth(snapshot.frame) * snapshot.scale);
                size_t height = (size_t)lround(NSHeight(snapshot.frame) * snapshot.scale);
                if (image != NULL && error == nil && CGImageGetWidth(image) == width &&
                    CGImageGetHeight(image) == height) {
                    [snapshot storeImage:image];
                }
                dispatch_group_leave(pending);
            }];
    }
    dispatch_group_notify(pending, dispatch_get_main_queue(), ^{
        for (DisplaySnapshot *snapshot in snapshots.objectEnumerator) {
            if (snapshot.image == NULL) {
                captureWithFilters(snapshots, output, allowOCR);
                return;
            }
        }
        showSelection(snapshots, output, allowOCR);
    });
}
#endif

API_AVAILABLE(macos(14.0))
static void startCapture(NSURL *output, BOOL allowOCR) {
    if (!CGPreflightScreenCaptureAccess() && !CGRequestScreenCaptureAccess()) {
        NSAlert *alert = [[NSAlert alloc] init];
        alert.messageText = @"截图需要屏幕录制权限";
        alert.informativeText = @"请在系统设置的「隐私与安全性」中允许屏幕录制，然后重新截图。";
        [alert addButtonWithTitle:@"好"];
        [NSApp activate];
        [alert runModal];
        exit(CapturePermissionDenied);
    }

    NSArray<NSScreen *> *screens = NSScreen.screens;
    if (screens.count == 0) {
        exit(CaptureUnavailable);
    }
    NSMutableDictionary<NSNumber *, DisplaySnapshot *> *snapshots = [NSMutableDictionary dictionaryWithCapacity:screens.count];
    for (NSScreen *screen in screens) {
        DisplaySnapshot *snapshot = [[DisplaySnapshot alloc] initWithScreen:screen];
        snapshots[@(snapshot.displayID)] = snapshot;
    }
#if __MAC_OS_X_VERSION_MAX_ALLOWED >= 150200
    if (@available(macOS 15.2, *)) {
        captureDisplayRects(snapshots, output, allowOCR);
        return;
    }
#endif
    captureWithFilters(snapshots, output, allowOCR);
}

int main(int argc, char **argv) {
    @autoreleasepool {
        if (argc != 2 && (argc != 3 || strcmp(argv[2], "ocr") != 0)) {
            return CaptureOutputFailed;
        }
        if (@available(macOS 14.0, *)) {
            // A forced backend stop must also remove any outstanding overlay.
            pid_t parent = getppid();
            if (parent <= 1) {
                return CaptureCancelled;
            }
            dispatch_source_t parentExit = dispatch_source_create(DISPATCH_SOURCE_TYPE_PROC, parent,
                                                                   DISPATCH_PROC_EXIT, dispatch_get_global_queue(QOS_CLASS_DEFAULT, 0));
            if (parentExit == nil || getppid() != parent) {
                return CaptureCancelled;
            }
            dispatch_source_set_event_handler(parentExit, ^{ _exit(CaptureCancelled); });
            dispatch_activate(parentExit);

            NSURL *output = [NSURL fileURLWithFileSystemRepresentation:argv[1] isDirectory:NO relativeToURL:nil];
            [NSApplication.sharedApplication setActivationPolicy:NSApplicationActivationPolicyAccessory];
            BOOL allowOCR = argc == 3;
            dispatch_async(dispatch_get_main_queue(), ^{ startCapture(output, allowOCR); });
            [NSApp run];
            dispatch_source_cancel(parentExit);
            return CaptureCancelled;
        }
        return CaptureUnsupported;
    }
}
