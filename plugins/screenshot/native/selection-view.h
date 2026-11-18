#import "snap-targets.h"

typedef NS_ENUM(NSInteger, CaptureDestination) {
    DestinationCancel, DestinationCopy, DestinationSave, DestinationOCR,
};

typedef NSString *(^CaptureOutput)(CaptureDestination, NSData *, NSWindow *);

@interface SelectionView : NSView <NSTextFieldDelegate>
- (instancetype)initWithFrame:(NSRect)frame
                        image:(CGImageRef)image
                     allowOCR:(BOOL)allowOCR
                  snapTargets:(CaptureSnapTargets *)snapTargets
                 displayFrame:(CGRect)displayFrame
                        begin:(void (^)(SelectionView *))begin
                       output:(CaptureOutput)output;
- (void)clearSelection;
@end
