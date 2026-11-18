#import "overlay-annotations.h"
#import <CoreText/CoreText.h>
#import <ImageIO/ImageIO.h>
#import <UniformTypeIdentifiers/UniformTypeIdentifiers.h>

static CTLineRef createTextLine(NSString *text, CTFontRef font) CF_RETURNS_RETAINED {

    CGColorRef red = CGColorCreateGenericRGB(0.91, 0.17, 0.2, 1);
    CGColorRef white = CGColorCreateGenericRGB(1, 1, 1, 1);
    NSDictionary *attributes = @{
        (__bridge NSString *)kCTFontAttributeName: (__bridge id)font,
        (__bridge NSString *)kCTForegroundColorAttributeName: (__bridge id)red,
        (__bridge NSString *)kCTStrokeColorAttributeName: (__bridge id)white,
        (__bridge NSString *)kCTStrokeWidthAttributeName: @(-2.0),
    };
    NSAttributedString *run = [[NSAttributedString alloc] initWithString:text attributes:attributes];
    CTLineRef line = CTLineCreateWithAttributedString((__bridge CFAttributedStringRef)run);
    CGColorRelease(white);
    CGColorRelease(red);
    return line;
}

static void drawText(CGContextRef context, NSString *text, NSPoint origin) {
    CTFontRef font = CTFontCreateUIFontForLanguage(kCTFontUIFontEmphasizedSystem, 20, NULL);
    CTLineRef line = createTextLine(text, font);
    CGContextSaveGState(context);
    CGContextTranslateCTM(context, origin.x, origin.y + CTFontGetAscent(font));
    CGContextScaleCTM(context, 1, -1);
    CGContextSetTextMatrix(context, CGAffineTransformIdentity);
    CGContextSetTextPosition(context, 0, 0);
    CTLineDraw(line, context);
    CGContextRestoreGState(context);
    CFRelease(line);
    CFRelease(font);
}

@implementation CaptureAnnotation

- (NSRect)bounds {
    if (self.tool == AnnotationText && self.text.length > 0) {
        CTFontRef font = CTFontCreateUIFontForLanguage(kCTFontUIFontEmphasizedSystem, 20, NULL);
        CTLineRef line = createTextLine(self.text, font);
        CGFloat ascent, descent, leading;
        CGFloat width = CTLineGetTypographicBounds(line, &ascent, &descent, &leading);
        CFRelease(line);
        CFRelease(font);
        return NSMakeRect(self.start.x, self.start.y, width, ascent + descent + leading);
    }
    return NSMakeRect(MIN(self.start.x, self.end.x), MIN(self.start.y, self.end.y),
                      fabs(self.end.x - self.start.x), fabs(self.end.y - self.start.y));
}

- (BOOL)isValid {
    if (self.tool == AnnotationText) {
        return self.text.length > 0;
    }
    if (self.tool == AnnotationArrow) {
        return hypot(self.end.x - self.start.x, self.end.y - self.start.y) >= 3;
    }
    return NSWidth(self.bounds) >= 2 && NSHeight(self.bounds) >= 2;
}

- (BOOL)hitTest:(NSPoint)point {
    const CGFloat tolerance = 6;
    NSRect bounds = self.bounds;
    if (!NSPointInRect(point, NSInsetRect(bounds, -tolerance, -tolerance))) {
        return NO;
    }
    switch (self.tool) {
        case AnnotationRectangle:
            return !NSPointInRect(point, NSInsetRect(bounds, tolerance, tolerance));
        case AnnotationArrow: {
            CGFloat dx = self.end.x - self.start.x, dy = self.end.y - self.start.y;
            CGFloat lengthSquared = dx * dx + dy * dy;
            if (lengthSquared == 0) {
                return NO;
            }
            CGFloat fraction = ((point.x - self.start.x) * dx + (point.y - self.start.y) * dy) / lengthSquared;
            fraction = MIN(MAX(fraction, 0), 1);
            return hypot(point.x - self.start.x - fraction * dx,
                         point.y - self.start.y - fraction * dy) <= tolerance;
        }
        default:
            return YES;
    }
}

- (void)drawInContext:(CGContextRef)context mosaic:(CGImageRef)mosaic bounds:(NSRect)bounds {
    if (![self isValid]) {
        return;
    }
    if (self.tool == AnnotationText) {
        drawText(context, self.text, self.start);
        return;
    }
    if (self.tool == AnnotationMosaic) {
        if (mosaic != NULL) {
            CGContextSaveGState(context);
            CGContextClipToRect(context, self.bounds);
            CGContextSetInterpolationQuality(context, kCGInterpolationNone);
            CGContextTranslateCTM(context, NSMinX(bounds), NSMaxY(bounds));
            CGContextScaleCTM(context, 1, -1);
            CGContextDrawImage(context, CGRectMake(0, 0, NSWidth(bounds), NSHeight(bounds)), mosaic);
            CGContextRestoreGState(context);
        }
        return;
    }
    CGContextSaveGState(context);
    CGContextSetLineWidth(context, 3);
    CGContextSetLineCap(context, kCGLineCapRound);
    CGContextSetLineJoin(context, kCGLineJoinRound);
    CGContextSetRGBStrokeColor(context, 0.91, 0.17, 0.2, 1);
    if (self.tool == AnnotationRectangle) {
        CGContextStrokeRect(context, self.bounds);
    } else {
        CGFloat dx = self.end.x - self.start.x;
        CGFloat dy = self.end.y - self.start.y;
        CGFloat length = hypot(dx, dy);
        CGFloat head = MIN(13, length * 0.45);
        CGFloat x = dx / length * head, y = dy / length * head;
        CGContextBeginPath(context);
        CGContextMoveToPoint(context, self.start.x, self.start.y);
        CGContextAddLineToPoint(context, self.end.x, self.end.y);
        CGContextMoveToPoint(context, self.end.x - x - y * 0.5, self.end.y - y + x * 0.5);
        CGContextAddLineToPoint(context, self.end.x, self.end.y);
        CGContextAddLineToPoint(context, self.end.x - x + y * 0.5, self.end.y - y - x * 0.5);
        CGContextStrokePath(context);
    }
    CGContextRestoreGState(context);
}
@end

CGImageRef createMosaicImage(CGImageRef image, NSSize points) {
    size_t width = MAX(1, (size_t)ceil(points.width / 12));
    size_t height = MAX(1, (size_t)ceil(points.height / 12));
    CGColorSpaceRef color = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
    CGContextRef context = CGBitmapContextCreate(NULL, width, height, 8, 0, color,
                                                 (CGBitmapInfo)kCGImageAlphaPremultipliedLast);
    CGColorSpaceRelease(color);
    if (context == NULL) {
        return NULL;
    }
    CGContextSetInterpolationQuality(context, kCGInterpolationLow);
    CGContextDrawImage(context, CGRectMake(0, 0, width, height), image);
    CGImageRef reduced = CGBitmapContextCreateImage(context);
    CGContextRelease(context);
    return reduced;
}

static NSData *encodePNG(CGImageRef image) {
    if (image == NULL) {
        return nil;
    }
    NSMutableData *data = [NSMutableData data];
    CGImageDestinationRef destination = CGImageDestinationCreateWithData(
        (__bridge CFMutableDataRef)data, (__bridge CFStringRef)UTTypePNG.identifier, 1, NULL);
    if (destination == NULL) {
        return nil;
    }
    CGImageDestinationAddImage(destination, image, NULL);
    BOOL written = CGImageDestinationFinalize(destination);
    CFRelease(destination);
    return written ? data : nil;
}

NSData *renderCapturePNG(CGImageRef desktop, CGRect pixels, NSSize points,
                         NSArray<CaptureAnnotation *> *annotations, CGImageRef mosaic) {
    CGImageRef cropped = CGImageCreateWithImageInRect(desktop, pixels);
    if (cropped == NULL) {
        return nil;
    }
    if (annotations.count == 0) {
        NSData *png = encodePNG(cropped);
        CGImageRelease(cropped);
        return png;
    }
    const size_t width = CGImageGetWidth(cropped), height = CGImageGetHeight(cropped);
    CGColorSpaceRef color = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
    CGContextRef context = CGBitmapContextCreate(NULL, width, height, 8, 0, color,
                                                 (CGBitmapInfo)kCGImageAlphaPremultipliedLast);
    CGColorSpaceRelease(color);
    if (context == NULL) {
        CGImageRelease(cropped);
        return nil;
    }
    CGContextDrawImage(context, CGRectMake(0, 0, width, height), cropped);
    CGImageRelease(cropped);

    CGContextTranslateCTM(context, -pixels.origin.x, height + pixels.origin.y);
    CGContextScaleCTM(context, CGImageGetWidth(desktop) / points.width,
                     -(CGImageGetHeight(desktop) / points.height));
    for (CaptureAnnotation *mark in annotations) {
        [mark drawInContext:context mosaic:mosaic bounds:(NSRect){NSZeroPoint, points}];
    }
    CGImageRef composed = CGBitmapContextCreateImage(context);
    CGContextRelease(context);
    NSData *png = encodePNG(composed);
    if (composed != NULL) {
        CGImageRelease(composed);
    }
    return png;
}
