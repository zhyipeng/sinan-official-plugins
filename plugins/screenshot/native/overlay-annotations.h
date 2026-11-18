#import <AppKit/AppKit.h>

typedef NS_ENUM(NSInteger, AnnotationTool) {
    AnnotationSelect, AnnotationArrow, AnnotationRectangle, AnnotationText, AnnotationMosaic,
};

@interface CaptureAnnotation : NSObject
@property AnnotationTool tool;
@property NSPoint start;
@property NSPoint end;
@property(copy) NSString *text;
- (BOOL)isValid;
- (NSRect)bounds;
- (BOOL)hitTest:(NSPoint)point;
- (void)drawInContext:(CGContextRef)context mosaic:(CGImageRef)mosaic bounds:(NSRect)bounds;
@end

CGImageRef createMosaicImage(CGImageRef image, NSSize points) CF_RETURNS_RETAINED;
NSData *renderCapturePNG(CGImageRef desktop, CGRect pixels, NSSize points,
                        NSArray<CaptureAnnotation *> *annotations, CGImageRef mosaic);
