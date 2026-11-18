#import "../overlay-annotations.h"
#import "../snap-targets.h"
#import <ImageIO/ImageIO.h>
#include <assert.h>

enum { width = 110, height = 100 };
static const CGBitmapInfo rgba = kCGBitmapByteOrder32Big | (CGBitmapInfo)kCGImageAlphaPremultipliedLast;

static CaptureAnnotation *mark(AnnotationTool tool, NSPoint start, NSPoint end) {
    CaptureAnnotation *value = [CaptureAnnotation new];
    value.tool = tool;
    value.start = start;
    value.end = end;
    return value;
}

static void readPixels(NSData *png, unsigned char *pixels, CGColorSpaceRef color) {
    assert(png.length > 0);
    CGImageSourceRef source = CGImageSourceCreateWithData((__bridge CFDataRef)png, NULL);
    CGImageRef image = CGImageSourceCreateImageAtIndex(source, 0, NULL);
    assert(CGImageGetWidth(image) == width && CGImageGetHeight(image) == height);
    CGContextRef bitmap = CGBitmapContextCreate(pixels, width, height, 8, width * 4, color, rgba);
    CGContextDrawImage(bitmap, CGRectMake(0, 0, width, height), image);
    CGContextRelease(bitmap);
    CGImageRelease(image);
    CFRelease(source);
}

static BOOL isRed(const unsigned char *pixels, size_t x, size_t y) {
    const unsigned char *color = pixels + (y * width + x) * 4;
    return color[0] > 180 && color[1] < 100 && color[2] < 100;
}

static BOOL matchesRGB(const unsigned char *pixels, size_t x, size_t y, uint32_t rgb) {
    const unsigned char *color = pixels + (y * width + x) * 4;
    return color[0] == ((rgb >> 16) & 0xff) && color[1] == ((rgb >> 8) & 0xff) &&
           color[2] == (rgb & 0xff) && color[3] == 255;
}

static void testSnapGeometry(void) {
    CaptureSnapWindow *front = [[CaptureSnapWindow alloc] initWithPID:1 frame:CGRectMake(-100, 70, 240, 160)];
    CaptureSnapWindow *back = [[CaptureSnapWindow alloc] initWithPID:2 frame:CGRectMake(-200, 20, 500, 310)];
    NSArray *windows = @[front, back];
    assert(captureSnapWindowAtPoint(windows, CGPointMake(-20, 90)) == front);
    assert(captureSnapWindowAtPoint(windows, CGPointMake(154, 90)) == back);
    assert(captureSnapWindowAtPoint(windows, CGPointMake(-300, 90)) == nil);

    CGRect leftDisplay = CGRectMake(-1920, -240, 1920, 1080);
    CGRect mainDisplay = CGRectMake(0, 0, 1440, 900);
    NSRect left = localSnapRect(front.frame, leftDisplay, NSMakeSize(1920, 1080));
    assert(NSEqualRects(left, NSMakeRect(1820, 310, 100, 160)));
    NSRect right = localSnapRect(front.frame, mainDisplay, NSMakeSize(1440, 900));
    assert(NSEqualRects(right, NSMakeRect(0, 70, 140, 160)));

    NSRect scaled = localSnapRect(CGRectMake(144, 162, 100, 50), mainDisplay, NSMakeSize(720, 450));
    assert(NSEqualRects(scaled, NSMakeRect(72, 81, 50, 25)));
    assert(NSIsEmptyRect(localSnapRect(CGRectMake(-2010, -26, 70, 36), leftDisplay, NSMakeSize(1920, 1080))));
    assert(NSIsEmptyRect(localSnapRect(CGRectInfinite, CGRectZero, NSMakeSize(1920, 1080))));
}

int main(void) {
    @autoreleasepool {
        testSnapGeometry();
        CGColorSpaceRef color = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
        CGContextRef background = CGBitmapContextCreate(NULL, 200, 160, 8, 0, color, rgba);
        CGContextSetRGBFillColor(background, 0, 0.6, 0.2, 1);
        CGContextFillRect(background, CGRectMake(0, 0, 200, 160));
        CGImageRef desktop = CGBitmapContextCreateImage(background);
        CGContextRelease(background);

        NSSize points = NSMakeSize(100, 80);
        CGRect crop = CGRectMake(20, 30, width, height);
        CaptureAnnotation *rectangle = mark(AnnotationRectangle, NSMakePoint(18, 22), NSMakePoint(54, 40));
        CaptureAnnotation *arrow = mark(AnnotationArrow, NSMakePoint(17, 52), NSMakePoint(50, 52));
        CaptureAnnotation *mosaic = mark(AnnotationMosaic, NSMakePoint(30, 19), NSMakePoint(40, 25));
        CGImageRef reduced = createMosaicImage(desktop, points);
        assert(reduced != NULL);
        unsigned char pixels[width * height * 4];
        readPixels(renderCapturePNG(desktop, crop, points, @[rectangle, arrow, mosaic], reduced), pixels, color);
        assert(isRed(pixels, 26, 14));
        assert(!isRed(pixels, 50, 14)); // A later mosaic obscures the stroke.
        assert(isRed(pixels, 35, 74)); // The arrow appears below the rectangle.
        assert(!isRed(pixels, 8, 8));
        assert([rectangle hitTest:NSMakePoint(22, 22)]);
        assert(![rectangle hitTest:NSMakePoint(36, 31)]);
        assert([arrow hitTest:NSMakePoint(35, 53)]);
        assert(![arrow hitTest:NSMakePoint(35, 65)]);
        assert([mosaic hitTest:NSMakePoint(33, 22)]);
        arrow.start = NSMakePoint(17, 59);
        arrow.end = NSMakePoint(50, 59);
        readPixels(renderCapturePNG(desktop, crop, points, @[arrow], NULL), pixels, color);
        assert(!isRed(pixels, 35, 74));
        assert(isRed(pixels, 35, 88));
        CGImageRelease(reduced);

        rectangle.rgb = 0x315ED8;
        arrow.rgb = 0xF4CB35;
        readPixels(renderCapturePNG(desktop, crop, points, @[rectangle, arrow], NULL), pixels, color);
        assert(matchesRGB(pixels, 26, 14, rectangle.rgb));
        assert(matchesRGB(pixels, 35, 88, arrow.rgb));

        CaptureAnnotation *text = mark(AnnotationText, NSMakePoint(18, 22), NSZeroPoint);
        text.text = @"司南";
        text.rgb = 0x8E58D3;
        assert([text hitTest:NSMakePoint(25, 32)]);
        assert(![text hitTest:NSMakePoint(90, 32)]);
        readPixels(renderCapturePNG(desktop, crop, points, @[text], NULL), pixels, color);
        size_t textPixels = 0;
        for (size_t y = 15; y < 60; y++) {
            for (size_t x = 10; x < 105; x++) {
                textPixels += matchesRGB(pixels, x, y, text.rgb);
            }
        }
        assert(textPixels > 30);
        CGImageRelease(desktop);
        CGColorSpaceRelease(color);
    }
    return 0;
}
