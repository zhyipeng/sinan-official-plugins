#import "selection-view.h"
#import "overlay-annotations.h"

static CGFloat clamp(CGFloat value, CGFloat lower, CGFloat upper) {
    return MIN(MAX(value, lower), upper);
}

static NSPoint clampPoint(NSPoint point, NSRect bounds) {
    return NSMakePoint(clamp(point.x, NSMinX(bounds), NSMaxX(bounds)),
                       clamp(point.y, NSMinY(bounds), NSMaxY(bounds)));
}

static NSRect rectBetween(NSPoint anchor, NSPoint point) {
    return NSMakeRect(MIN(anchor.x, point.x), MIN(anchor.y, point.y),
                      fabs(point.x - anchor.x), fabs(point.y - anchor.y));
}

// The view and the CGImage crop both use a top-left origin. Round outward
// so a selection on a fractional point boundary includes the touched pixels.
static CGRect pixelRect(NSRect selection, NSSize points, CGSize pixels) {
    CGFloat scaleX = pixels.width / points.width;
    CGFloat scaleY = pixels.height / points.height;
    CGFloat x = floor(NSMinX(selection) * scaleX);
    CGFloat y = floor(NSMinY(selection) * scaleY);
    CGRect mapped = CGRectMake(x, y, ceil(NSMaxX(selection) * scaleX) - x,
                               ceil(NSMaxY(selection) * scaleY) - y);
    return CGRectIntersection(mapped, CGRectMake(0, 0, pixels.width, pixels.height));
}

typedef NS_OPTIONS(NSUInteger, SelectionEdge) {
    EdgeNone = 0,
    EdgeLeft = 1 << 0,
    EdgeRight = 1 << 1,
    EdgeTop = 1 << 2,
    EdgeBottom = 1 << 3,
};

static NSImage *colorSwatch(uint32_t rgb) {
    NSColor *fill = captureAnnotationColor(rgb);
    return [NSImage imageWithSize:NSMakeSize(16, 16) flipped:NO drawingHandler:^BOOL(NSRect rect) {
        NSBezierPath *swatch = [NSBezierPath bezierPathWithRoundedRect:NSInsetRect(rect, 0.5, 0.5)
                                                            xRadius:4 yRadius:4];
        [fill setFill];
        [swatch fill];
        [NSColor.separatorColor setStroke];
        [swatch stroke];
        return YES;
    }];
}

static dispatch_queue_t elementLookupQueue(void) {
    static dispatch_queue_t queue;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        queue = dispatch_queue_create("com.sinan.screenshot.element-hit-test", DISPATCH_QUEUE_SERIAL);
    });
    return queue;
}

@implementation SelectionView {
    CGImageRef _desktop;
    CaptureSnapTargets *_snapTargets;
    CGRect _displayFrame;
    NSTrackingArea *_snapTracking;
    CaptureSnapWindow *_hoverWindow;
    NSRect _hoverBounds;
    NSRect _pendingSnap;
    CGPoint _lookupPoint;
    NSTimer *_lookupTimer;
    BOOL _lookupRunning;
    NSUInteger _lookupRevision;
    NSArray<NSValue *> *_elementCandidates;
    NSUInteger _candidateIndex;
    CGFloat _scrollDistance;
    NSImage *_background;
    CGImageRef _mosaic;
    NSMutableArray<CaptureAnnotation *> *_marks;
    NSMutableArray<dispatch_block_t> *_undoActions;
    CaptureAnnotation *_selectedMark;
    BOOL _movingMark;
    NSPoint _markInitialStart;
    NSPoint _markInitialEnd;
    CaptureAnnotation *_draft;
    AnnotationTool _tool;
    NSStackView *_toolbar;
    NSButton *_colorButton;
    NSStackView *_palette;
    NSTextField *_hexField;
    uint32_t _annotationRGB;
    uint32_t _displayedRGB;
    BOOL _allowOCR;
    NSArray<NSButton *> *_tools;
    NSButton *_undo;
    NSTextField *_feedback;
    NSTextField *_textInput;
    NSPoint _textAnchor;
    CaptureOutput _output;
    CGSize _pixels;
    void (^_begin)(SelectionView *);
    NSRect _selection;
    NSRect _initial;
    NSPoint _anchor;
    SelectionEdge _edges;
    BOOL _dragging;
    BOOL _moving;
}

- (instancetype)initWithFrame:(NSRect)frame
                        image:(CGImageRef)image
                     allowOCR:(BOOL)allowOCR
                  snapTargets:(CaptureSnapTargets *)snapTargets
                 displayFrame:(CGRect)displayFrame
                        begin:(void (^)(SelectionView *))begin
                       output:(CaptureOutput)output {
    self = [super initWithFrame:frame];
    if (self) {
        _desktop = CGImageRetain(image);
        _snapTargets = snapTargets;
        _displayFrame = displayFrame;
        [NSNotificationCenter.defaultCenter addObserver:self selector:@selector(snapTargetsChanged:)
                                                   name:CaptureSnapTargetsDidChange object:snapTargets];
        _background = [[NSImage alloc] initWithCGImage:image size:frame.size];
        _pixels = CGSizeMake(CGImageGetWidth(image), CGImageGetHeight(image));
        _begin = [begin copy];
        _output = [output copy];
        _marks = [NSMutableArray array];
        _undoActions = [NSMutableArray array];
        _allowOCR = allowOCR;
        _annotationRGB = CaptureDefaultAnnotationRGB;
        _displayedRGB = UINT32_MAX;
    }
    return self;
}

- (void)dealloc {
    [NSNotificationCenter.defaultCenter removeObserver:self];
    [_lookupTimer invalidate];
    if (_desktop != NULL) {
        CGImageRelease(_desktop);
    }
    if (_mosaic != NULL) {
        CGImageRelease(_mosaic);
    }
}

- (NSButton *)symbolButton:(NSString *)symbol label:(NSString *)label action:(SEL)action tag:(NSInteger)tag {
    NSButton *button = [NSButton buttonWithTitle:label target:self action:action];
    NSImageSymbolConfiguration *configuration = [NSImageSymbolConfiguration
        configurationWithPointSize:16 weight:NSFontWeightMedium scale:NSImageSymbolScaleMedium];
    NSImage *image = [NSImage imageWithSystemSymbolName:symbol accessibilityDescription:label];
    if (image != nil) {
        button.image = [image imageWithSymbolConfiguration:configuration];
        button.imagePosition = NSImageOnly;
        [button.widthAnchor constraintEqualToConstant:32].active = YES;
    }
    [button.heightAnchor constraintEqualToConstant:30].active = YES;
    button.translatesAutoresizingMaskIntoConstraints = NO;
    button.bezelStyle = NSBezelStyleRecessed;
    button.tag = tag;
    button.toolTip = label;
    button.accessibilityLabel = label;
    return button;
}

- (void)setupToolbar:(BOOL)allowOCR {
    NSMutableArray<NSButton *> *tools = [NSMutableArray array];
    NSArray<NSArray<NSString *> *> *items = @[
        @[@"viewfinder", @"选区"], @[@"arrow.up.right", @"箭头"], @[@"rectangle", @"矩形"],
        @[@"textformat", @"文字"], @[@"square.grid.3x3", @"马赛克"],
    ];
    for (NSUInteger i = 0; i < items.count; i++) {
        NSButton *button = [self symbolButton:items[i][0] label:items[i][1] action:@selector(chooseTool:) tag:i];
        [button setButtonType:NSButtonTypePushOnPushOff];
        [tools addObject:button];
    }
    _tools = tools;
    [self setTool:AnnotationSelect];
    _tools[AnnotationSelect].toolTip = @"拖动选区或已有标注";

    _undo = [self symbolButton:@"arrow.uturn.backward" label:@"撤销" action:@selector(undoLast:) tag:0];
    _undo.toolTip = @"撤销上一个操作（⌘Z）";
    NSButton *copy = [self symbolButton:@"square.on.square" label:@"复制并关闭"
                                 action:@selector(outputFromButton:) tag:DestinationCopy];
    copy.toolTip = @"复制并关闭（⌘C 或 Return）";
    copy.contentTintColor = [NSColor colorWithSRGBRed:0.19 green:0.37 blue:0.85 alpha:1];
    NSButton *save = [self symbolButton:@"arrow.down.to.line" label:@"保存 PNG"
                                 action:@selector(outputFromButton:) tag:DestinationSave];
    save.toolTip = @"保存 PNG（⌘S）";
    NSButton *ocr = [self symbolButton:@"text.viewfinder" label:@"OCR 识别"
                                action:@selector(outputFromButton:) tag:DestinationOCR];
    ocr.enabled = allowOCR;
    ocr.toolTip = allowOCR ? @"OCR 识别选区" : @"安装并启用 OCR 插件后可用";
    _colorButton = [self symbolButton:@"circle" label:@"标注颜色" action:@selector(togglePalette:) tag:0];
    _toolbar = [NSStackView stackViewWithViews:[_tools arrayByAddingObjectsFromArray:@[_colorButton, _undo, copy, save, ocr]]];
    _toolbar.orientation = NSUserInterfaceLayoutOrientationHorizontal;
    _toolbar.spacing = 2;
    _toolbar.edgeInsets = NSEdgeInsetsMake(4, 6, 4, 6);
    _toolbar.wantsLayer = YES;
    _toolbar.layer.backgroundColor = NSColor.windowBackgroundColor.CGColor;
    _toolbar.layer.cornerRadius = 8;
    _toolbar.layer.shadowColor = NSColor.blackColor.CGColor;
    _toolbar.layer.shadowOpacity = 0.28;
    _toolbar.layer.shadowRadius = 7;
    _toolbar.hidden = YES;
    [self addSubview:_toolbar];

    _feedback = [NSTextField labelWithString:@""];
    _feedback.hidden = YES;
    _feedback.backgroundColor = NSColor.windowBackgroundColor;
    _feedback.drawsBackground = YES;
    _feedback.alignment = NSTextAlignmentCenter;
    [self addSubview:_feedback];
}

- (uint32_t)visibleAnnotationRGB {
    if (_selectedMark != nil && _selectedMark.tool != AnnotationMosaic) {
        return _selectedMark.rgb;
    }
    return _annotationRGB;
}

- (void)updateColorButton {
    uint32_t rgb = [self visibleAnnotationRGB];
    if (_colorButton == nil || rgb == _displayedRGB) {
        return;
    }
    _displayedRGB = rgb;
    _colorButton.image = colorSwatch(rgb);
    _colorButton.toolTip = [NSString stringWithFormat:@"标注颜色 #%06X", rgb];
    _colorButton.accessibilityValue = [NSString stringWithFormat:@"#%06X", rgb];
}

- (void)setupPalette {
    NSArray<NSNumber *> *colors = @[@(CaptureDefaultAnnotationRGB), @0xFF8A22, @0xF4CB35,
                                    @0x21A160, @0x315ED8, @0x8E58D3, @0x20232A, @0xFFFFFF];
    NSArray<NSString *> *names = @[@"红色", @"橙色", @"黄色", @"绿色", @"蓝色", @"紫色", @"黑色", @"白色"];
    NSMutableArray<NSView *> *items = [NSMutableArray array];
    for (NSUInteger i = 0; i < colors.count; i++) {
        NSButton *swatch = [NSButton buttonWithImage:colorSwatch(colors[i].unsignedIntValue)
                                             target:self action:@selector(chooseColor:)];
        swatch.tag = colors[i].unsignedIntValue;
        swatch.bezelStyle = NSBezelStyleRecessed;
        swatch.toolTip = names[i];
        swatch.accessibilityLabel = names[i];
        swatch.translatesAutoresizingMaskIntoConstraints = NO;
        [swatch.widthAnchor constraintEqualToConstant:25].active = YES;
        [swatch.heightAnchor constraintEqualToConstant:26].active = YES;
        [items addObject:swatch];
    }
    _hexField = [NSTextField textFieldWithString:@""];
    _hexField.font = [NSFont monospacedSystemFontOfSize:11 weight:NSFontWeightRegular];
    _hexField.placeholderString = @"#RRGGBB";
    _hexField.toolTip = @"输入十六进制颜色，按回车应用";
    _hexField.accessibilityLabel = @"十六进制颜色";
    _hexField.usesSingleLineMode = YES;
    _hexField.delegate = self;
    _hexField.translatesAutoresizingMaskIntoConstraints = NO;
    [_hexField.widthAnchor constraintEqualToConstant:70].active = YES;
    [items addObject:_hexField];

    _palette = [NSStackView stackViewWithViews:items];
    _palette.orientation = NSUserInterfaceLayoutOrientationHorizontal;
    _palette.edgeInsets = NSEdgeInsetsMake(4, 6, 4, 6);
    _palette.spacing = 2;
    _palette.wantsLayer = YES;
    _palette.layer.backgroundColor = NSColor.windowBackgroundColor.CGColor;
    _palette.layer.cornerRadius = 8;
    _palette.layer.shadowOpacity = 0.25;
    _palette.layer.shadowRadius = 6;
    _palette.hidden = YES;
    [self addSubview:_palette];
}

- (void)togglePalette:(__unused NSButton *)button {
    if (_palette == nil) {
        [self setupPalette];
    }
    _palette.hidden = !_palette.hidden;
    _feedback.stringValue = @"";
    if (!_palette.hidden) {
        _hexField.stringValue = [NSString stringWithFormat:@"#%06X", [self visibleAnnotationRGB]];
    }
    [self.window makeFirstResponder:self];
    [self updateToolbar];
}

- (void)applyAnnotationRGB:(uint32_t)rgb {
    _annotationRGB = rgb;
    CaptureAnnotation *mark = _selectedMark;
    if (mark != nil && mark.tool != AnnotationMosaic && mark.rgb != rgb) {
        uint32_t previous = mark.rgb;
        [_undoActions addObject:^{ mark.rgb = previous; }];
        mark.rgb = rgb;
    }
    _palette.hidden = YES;
    _feedback.stringValue = @"";
    [self.window makeFirstResponder:self];
    self.needsDisplay = YES;
    [self updateToolbar];
}

- (void)chooseColor:(NSButton *)button {
    [self applyAnnotationRGB:(uint32_t)button.tag];
}

- (void)commitHexColor:(NSString *)value {
    NSString *hex = [value stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
    if ([hex hasPrefix:@"#"]) {
        hex = [hex substringFromIndex:1];
    }
    NSCharacterSet *invalid = [[NSCharacterSet characterSetWithCharactersInString:@"0123456789ABCDEFabcdef"] invertedSet];
    unsigned int rgb;
    if (hex.length == 6 && [hex rangeOfCharacterFromSet:invalid].location == NSNotFound &&
        [[NSScanner scannerWithString:hex] scanHexInt:&rgb]) {
        [self applyAnnotationRGB:rgb];
    } else {
        _feedback.stringValue = @"请输入 6 位十六进制颜色";
        [self updateToolbar];
    }
}

- (void)updateToolbar {
    BOOL hidden = _dragging || CGRectIsNull([self selectionInPixels]);
    if (_toolbar == nil) {
        if (hidden) {
            return;
        }
        [self setupToolbar:_allowOCR];
    }
    _toolbar.hidden = hidden;
    if (hidden) {
        _palette.hidden = YES;
    }
    _feedback.hidden = _toolbar.hidden || _feedback.stringValue.length == 0;
    if (_toolbar.hidden) {
        return;
    }
    _undo.enabled = _undoActions.count > 0;
    [self updateColorButton];
    NSSize size = _toolbar.fittingSize;
    CGFloat x = clamp(NSMaxX(_selection) - size.width, 8, MAX(8, NSWidth(self.bounds) - size.width - 8));
    CGFloat y = NSMaxY(_selection) + 7;
    if (y + size.height > NSHeight(self.bounds) - 8) {
        y = MAX(8, NSMinY(_selection) - size.height - 7);
        if (y < NSMinY(_selection) && y + size.height > NSMinY(_selection)) {
            y = NSHeight(self.bounds) - size.height - 8;
        }
    }
    _toolbar.frame = NSMakeRect(x, y, size.width, size.height);
    CGFloat feedbackY = y >= 30 ? y - 24 : y + size.height + 4;
    if (_palette != nil && !_palette.hidden) {
        NSSize paletteSize = _palette.fittingSize;
        CGFloat paletteX = clamp(NSMaxX(_toolbar.frame) - paletteSize.width, 8,
                                 MAX(8, NSWidth(self.bounds) - paletteSize.width - 8));
        CGFloat below = y + size.height + 5;
        BOOL fitsBelow = below + paletteSize.height + 8 <= NSHeight(self.bounds);
        CGFloat paletteY = fitsBelow ? below : MAX(8, y - paletteSize.height - 5);
        _palette.frame = NSMakeRect(paletteX, paletteY, paletteSize.width, paletteSize.height);
        feedbackY = fitsBelow ? MAX(0, y - 24) : MIN(NSHeight(self.bounds) - 20, below);
    }
    _feedback.frame = NSMakeRect(x, feedbackY, size.width, 20);
}

- (void)setTool:(AnnotationTool)tool {
    _tool = tool;
    _palette.hidden = YES;
    _selectedMark = nil;
    self.needsDisplay = YES;
    for (NSButton *button in _tools) {
        BOOL selected = button.tag == tool;
        button.state = selected ? NSControlStateValueOn : NSControlStateValueOff;
        button.contentTintColor = selected ? [NSColor colorWithSRGBRed:0.19 green:0.37 blue:0.85 alpha:1] : nil;
    }
}

- (void)chooseTool:(NSButton *)button {
    [self commitText];
    _feedback.stringValue = @"";
    [self setTool:button.tag];
    [self.window makeFirstResponder:self];
    [self updateToolbar];
}

- (void)undoLast:(__unused id)sender {
    [self commitText];
    dispatch_block_t undo = _undoActions.lastObject;
    if (undo != nil) {
        [_undoActions removeLastObject];
        undo();
    }
    if (_selectedMark != nil && ![_marks containsObject:_selectedMark]) {
        _selectedMark = nil;
    }
    _feedback.stringValue = @"";
    self.needsDisplay = YES;
    [self updateToolbar];
    [self.window makeFirstResponder:self];
}

- (void)addMark:(CaptureAnnotation *)mark {
    NSMutableArray *marks = _marks;
    [marks addObject:mark];
    [_undoActions addObject:^{ [marks removeObjectIdenticalTo:mark]; }];
}

- (void)beginTextAt:(NSPoint)point {
    _textAnchor = point;
    CGFloat width = MIN(250, NSWidth(self.bounds) - 16);
    _textInput = [[NSTextField alloc] initWithFrame:NSMakeRect(
        clamp(point.x, 8, NSWidth(self.bounds) - width - 8),
        clamp(point.y, 8, NSHeight(self.bounds) - 32), width, 24)];
    _textInput.placeholderString = @"输入文字，回车确认";
    _textInput.font = [NSFont systemFontOfSize:15];
    _textInput.usesSingleLineMode = YES;
    _textInput.delegate = self;
    [self addSubview:_textInput];
    [self.window makeFirstResponder:_textInput];
}

- (void)removeTextInput {
    NSTextField *field = _textInput;
    _textInput = nil;
    [field removeFromSuperview];
}

- (void)commitText {
    if (_textInput == nil) {
        return;
    }
    NSText *editor = _textInput.currentEditor;
    if ([editor isKindOfClass:NSTextView.class]) {
        [(NSTextView *)editor unmarkText];
    }
    NSString *value = [editor.string ?: _textInput.stringValue
        stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
    [self removeTextInput];
    if (value.length) {
        CaptureAnnotation *mark = [CaptureAnnotation new];
        mark.tool = AnnotationText;
        mark.start = _textAnchor;
        mark.rgb = _annotationRGB;
        mark.text = value;
        [self addMark:mark];
        self.needsDisplay = YES;
    }
    [self updateToolbar];
}

- (BOOL)control:(NSControl *)control textView:(NSTextView *)editor doCommandBySelector:(SEL)selector {
    if (control == _hexField) {
        if (selector == @selector(insertNewline:)) {
            [self commitHexColor:editor.string];
            return YES;
        }
        if (selector == @selector(cancelOperation:)) {
            [self togglePalette:nil];
            return YES;
        }
        return NO;
    }
    if (selector == @selector(insertNewline:)) {
        [self commitText];
    } else if (selector == @selector(cancelOperation:)) {
        [self removeTextInput];
    } else {
        return NO;
    }
    [self.window makeFirstResponder:self];
    return YES;
}

- (void)outputTo:(CaptureDestination)destination {
    CGRect pixels = [self selectionInPixels];
    if (CGRectIsNull(pixels) || _dragging || _movingMark || _draft != nil) {
        return;
    }
    [self commitText];
    [self.window makeFirstResponder:self];
    NSData *png = renderCapturePNG(_desktop, pixels, self.bounds.size, _marks, _mosaic);
    if (png.length == 0) {
        _feedback.stringValue = @"截图生成失败，请重试";
    } else if (destination == DestinationOCR && png.length > 4 * 1024 * 1024) {
        _feedback.stringValue = @"OCR 图片超过 4 MiB，请缩小选区";
    } else if (png.length > 8 * 1024 * 1024) {
        _feedback.stringValue = @"截图超过 8 MiB，请缩小选区";
    } else {
        _feedback.stringValue = _output(destination, png, self.window) ?: @"";
    }
    [self updateToolbar];
}

- (void)outputFromButton:(NSButton *)button {
    [self outputTo:button.tag];
}

- (BOOL)isFlipped { return YES; }
- (BOOL)acceptsFirstResponder { return YES; }
- (BOOL)acceptsFirstMouse:(NSEvent *)event { return YES; }

- (void)resetCursorRects {
    [self addCursorRect:self.bounds cursor:NSCursor.crosshairCursor];
}

- (CGRect)selectionInPixels {
    if (NSIsEmptyRect(_selection)) {
        return CGRectNull;
    }
    CGRect rect = pixelRect(_selection, self.bounds.size, _pixels);
    return rect.size.width >= 2 && rect.size.height >= 2 ? rect : CGRectNull;
}

- (void)updateTrackingAreas {
    [super updateTrackingAreas];
    if (_snapTracking != nil) {
        [self removeTrackingArea:_snapTracking];
    }
    _snapTracking = [[NSTrackingArea alloc] initWithRect:NSZeroRect
        options:NSTrackingMouseMoved | NSTrackingMouseEnteredAndExited | NSTrackingActiveAlways |
                NSTrackingInVisibleRect owner:self userInfo:nil];
    [self addTrackingArea:_snapTracking];
}

- (BOOL)canPreviewSnap {
    return !_dragging && NSIsEmptyRect(_selection) && self.window != nil;
}

- (void)clearHover {
    [_lookupTimer invalidate];
    _lookupTimer = nil;
    _lookupRevision++;
    _hoverWindow = nil;
    _elementCandidates = nil;
    _candidateIndex = 0;
    _scrollDistance = 0;
    if (!NSIsEmptyRect(_hoverBounds)) {
        _hoverBounds = NSZeroRect;
        self.needsDisplay = YES;
    }
}

- (void)updateHoverBounds {
    NSRect bounds = NSZeroRect;
    if (_elementCandidates.count > 0) {
        bounds = [_elementCandidates[_candidateIndex] rectValue];
    } else if (_hoverWindow != nil) {
        bounds = localSnapRect(_hoverWindow.frame, _displayFrame, self.bounds.size);
    }
    if (!NSEqualRects(bounds, _hoverBounds)) {
        _hoverBounds = bounds;
        self.needsDisplay = YES;
    }
}

- (void)scheduleElementLookup {
    if (_lookupRunning || _lookupTimer != nil || _hoverWindow == nil ||
        !_snapTargets.elementMode || !_snapTargets.accessibilityTrusted || ![self canPreviewSnap]) {
        return;
    }
    __weak SelectionView *weakSelf = self;
    _lookupTimer = [NSTimer scheduledTimerWithTimeInterval:0.045 repeats:NO block:^(__unused NSTimer *timer) {
        [weakSelf lookupElement];
    }];
}

- (void)lookupElement {
    _lookupTimer = nil;
    CaptureSnapWindow *window = _hoverWindow;
    CGPoint point = _lookupPoint;
    NSUInteger revision = _lookupRevision;
    _lookupRunning = YES;
    __weak SelectionView *weakSelf = self;
    dispatch_async(elementLookupQueue(), ^{
        NSArray<NSValue *> *rects = captureElementRects(window, point);
        dispatch_async(dispatch_get_main_queue(), ^{
            [weakSelf completeElementLookup:rects revision:revision];
        });
    });
}

- (void)completeElementLookup:(NSArray<NSValue *> *)rects revision:(NSUInteger)revision {
    _lookupRunning = NO;
    if (revision != _lookupRevision) {
        [self scheduleElementLookup];
        return;
    }

    NSMutableArray<NSValue *> *local = [NSMutableArray array];
    NSRect windowRect = localSnapRect(_hoverWindow.frame, _displayFrame, self.bounds.size);
    for (NSValue *rect in rects) {
        NSRect candidate = localSnapRect(rect.rectValue, _displayFrame, self.bounds.size);
        if (!NSIsEmptyRect(candidate) && !NSEqualRects(candidate, windowRect)) {
            NSValue *value = [NSValue valueWithRect:candidate];
            if (![local containsObject:value]) {
                [local addObject:value];
            }
        }
    }
    if (local.count > 0 && !NSIsEmptyRect(windowRect)) {
        [local addObject:[NSValue valueWithRect:windowRect]];
    }
    _elementCandidates = local;
    _candidateIndex = 0;
    _scrollDistance = 0;
    [self updateHoverBounds];
}

- (void)refreshHoverAtPoint:(NSPoint)point {
    if (![self canPreviewSnap] || !NSPointInRect(point, self.bounds)) {
        [self clearHover];
        return;
    }
    CGPoint screenPoint = CGPointMake(_displayFrame.origin.x + point.x * _displayFrame.size.width / NSWidth(self.bounds),
                                      _displayFrame.origin.y + point.y * _displayFrame.size.height / NSHeight(self.bounds));
    CaptureSnapWindow *window = captureSnapWindowAtPoint(_snapTargets.windows, screenPoint);
    if (window == nil) {
        [self clearHover];
        return;
    }
    if (_hoverWindow == window && hypot(screenPoint.x - _lookupPoint.x, screenPoint.y - _lookupPoint.y) < 3) {
        return;
    }
    BOOL keepCandidate = _hoverWindow == window && NSPointInRect(point, _hoverBounds);
    _hoverWindow = window;
    _lookupPoint = screenPoint;
    _lookupRevision++;
    [_lookupTimer invalidate];
    _lookupTimer = nil;
    if (!keepCandidate) {
        _elementCandidates = nil;
        _candidateIndex = 0;
        _scrollDistance = 0;
    }
    [self updateHoverBounds];
    [self scheduleElementLookup];
}

- (void)refreshHoverAtPointer {
    if (self.window != nil) {
        [self refreshHoverAtPoint:[self convertPoint:self.window.mouseLocationOutsideOfEventStream fromView:nil]];
    }
}

- (void)snapTargetsChanged:(__unused NSNotification *)notification {
    [self clearHover];
    [self refreshHoverAtPointer];
    self.needsDisplay = YES;
}

- (void)mouseEntered:(NSEvent *)event { [self mouseMoved:event]; }
- (void)mouseExited:(__unused NSEvent *)event { [self clearHover]; }

- (void)mouseMoved:(NSEvent *)event {
    [self refreshHoverAtPoint:[self convertPoint:event.locationInWindow fromView:nil]];
}

- (void)scrollWheel:(NSEvent *)event {
    NSUInteger count = _elementCandidates.count;
    if (count < 2 || ![self canPreviewSnap] || event.momentumPhase != NSEventPhaseNone) {
        return;
    }
    _scrollDistance += event.scrollingDeltaY;
    CGFloat threshold = event.hasPreciseScrollingDeltas ? 15 : 1;
    if (fabs(_scrollDistance) >= threshold) {
        _candidateIndex = (_candidateIndex + (_scrollDistance > 0 ? 1 : count - 1)) % count;
        _scrollDistance = 0;
        [self updateHoverBounds];
    }
}

- (void)drawHint {
    NSString *text = @"窗口吸附  ·  单击选取或拖动框选  ·  Tab 切换";
    if (_snapTargets.elementMode) {
        text = _snapTargets.accessibilityTrusted
            ? @"元素吸附  ·  滚轮切换候选  ·  Tab 切回窗口"
            : @"元素吸附需辅助功能授权，当前使用窗口吸附";
    }
    NSDictionary *attributes = @{
        NSFontAttributeName: [NSFont systemFontOfSize:13 weight:NSFontWeightMedium],
        NSForegroundColorAttributeName: NSColor.whiteColor,
    };
    NSSize size = [text sizeWithAttributes:attributes];
    NSRect bubble = NSMakeRect(NSMidX(self.bounds) - (size.width + 24) / 2,
                              NSMaxY(self.bounds) - size.height - 32, size.width + 24, size.height + 12);
    [[NSColor colorWithWhite:0.12 alpha:0.9] setFill];
    [[NSBezierPath bezierPathWithRoundedRect:bubble xRadius:6 yRadius:6] fill];
    [text drawAtPoint:NSMakePoint(NSMinX(bubble) + 12, NSMinY(bubble) + 6) withAttributes:attributes];
}

- (void)drawRect:(NSRect)dirtyRect {
    [_background drawInRect:self.bounds fromRect:NSZeroRect operation:NSCompositingOperationCopy
                   fraction:1 respectFlipped:YES hints:nil];

    NSRect preview = NSIsEmptyRect(_pendingSnap) ? _hoverBounds : _pendingSnap;
    NSRect bright = NSIsEmptyRect(_selection) ? preview : _selection;
    NSBezierPath *shade = [NSBezierPath bezierPathWithRect:self.bounds];
    if (!NSIsEmptyRect(bright)) {
        [shade appendBezierPathWithRect:bright];
    }
    shade.windingRule = NSWindingRuleEvenOdd;
    [[NSColor colorWithWhite:0 alpha:0.42] setFill];
    [shade fill];

    CGRect pixels = [self selectionInPixels];
    if (CGRectIsNull(pixels)) {
        if (!NSIsEmptyRect(preview)) {
            [[NSColor colorWithSRGBRed:0.19 green:0.37 blue:0.85 alpha:1] setStroke];
            [NSBezierPath strokeRect:NSInsetRect(preview, 0.5, 0.5)];
        }
        [self drawHint];
        return;
    }

    CGContextRef context = NSGraphicsContext.currentContext.CGContext;
    CGContextSaveGState(context);
    CGContextClipToRect(context, _selection);
    for (CaptureAnnotation *mark in _marks) {
        [mark drawInContext:context mosaic:_mosaic bounds:self.bounds];
    }
    [_draft drawInContext:context mosaic:_mosaic bounds:self.bounds];
    if (_selectedMark != nil) {
        CGFloat dash[] = {4, 3};
        CGContextSetLineDash(context, 0, dash, 2);
        CGContextSetRGBStrokeColor(context, 0.19, 0.37, 0.85, 1);
        CGContextStrokeRectWithWidth(context, NSInsetRect(_selectedMark.bounds, -4, -4), 1);
    }
    CGContextRestoreGState(context);

    NSColor *accent = [NSColor colorWithSRGBRed:0.19 green:0.37 blue:0.85 alpha:1];
    [accent setStroke];
    [NSBezierPath strokeRect:_selection];

    [accent setFill];
    for (NSNumber *x in @[@(NSMinX(_selection)), @(NSMaxX(_selection))]) {
        for (NSNumber *y in @[@(NSMinY(_selection)), @(NSMaxY(_selection))]) {
            NSRect handle = NSMakeRect(x.doubleValue - 3, y.doubleValue - 3, 6, 6);
            [[NSBezierPath bezierPathWithRoundedRect:handle xRadius:1 yRadius:1] fill];
        }
    }

    NSString *label = [NSString stringWithFormat:@"%.0f × %.0f", pixels.size.width, pixels.size.height];
    NSDictionary *attributes = @{
        NSFontAttributeName: [NSFont monospacedDigitSystemFontOfSize:12 weight:NSFontWeightMedium],
        NSForegroundColorAttributeName: NSColor.whiteColor,
    };
    NSSize size = [label sizeWithAttributes:attributes];
    NSRect badge = NSMakeRect(NSMinX(_selection), NSMinY(_selection) - size.height - 12,
                              size.width + 12, size.height + 6);
    badge.origin.x = clamp(badge.origin.x, 0, MAX(0, NSWidth(self.bounds) - NSWidth(badge)));
    if (badge.origin.y < 0) {
        badge.origin.y = NSMinY(_selection) + 6;
    }
    badge.origin.y = clamp(badge.origin.y, 0, MAX(0, NSHeight(self.bounds) - NSHeight(badge)));
    [[NSColor colorWithWhite:0.12 alpha:0.9] setFill];
    [[NSBezierPath bezierPathWithRoundedRect:badge xRadius:4 yRadius:4] fill];
    [label drawAtPoint:NSMakePoint(NSMinX(badge) + 6, NSMinY(badge) + 3) withAttributes:attributes];
}

- (SelectionEdge)edgesAtPoint:(NSPoint)point {
    const CGFloat margin = 6;
    if (NSIsEmptyRect(_selection) || !NSPointInRect(point, NSInsetRect(_selection, -margin, -margin))) {
        return EdgeNone;
    }
    CGFloat left = fabs(point.x - NSMinX(_selection));
    CGFloat right = fabs(point.x - NSMaxX(_selection));
    CGFloat top = fabs(point.y - NSMinY(_selection));
    CGFloat bottom = fabs(point.y - NSMaxY(_selection));
    SelectionEdge edges = EdgeNone;
    if (MIN(left, right) <= margin) {
        edges |= left <= right ? EdgeLeft : EdgeRight;
    }
    if (MIN(top, bottom) <= margin) {
        edges |= top <= bottom ? EdgeTop : EdgeBottom;
    }
    return edges;
}

- (NSPoint)pointForEvent:(NSEvent *)event {
    return clampPoint([self convertPoint:event.locationInWindow fromView:nil], self.bounds);
}

- (void)clearSelection {
    if (NSIsEmptyRect(_selection) && !_dragging) {
        return;
    }
    _selection = NSZeroRect;
    _pendingSnap = NSZeroRect;
    _dragging = NO;
    _draft = nil;
    [_marks removeAllObjects];
    [_undoActions removeAllObjects];
    _movingMark = NO;
    [self removeTextInput];
    [self setTool:AnnotationSelect];
    _feedback.stringValue = @"";
    [self updateToolbar];
    self.needsDisplay = YES;
}

- (void)mouseDown:(NSEvent *)event {
    _begin(self);
    if (_palette != nil && !_palette.hidden) {
        _palette.hidden = YES;
        _feedback.stringValue = @"";
    }
    [self commitText];
    [self.window makeFirstResponder:self];
    NSPoint point = [self pointForEvent:event];
    if (NSIsEmptyRect(_selection) && NSPointInRect(point, _hoverBounds)) {
        _pendingSnap = _hoverBounds;
    }
    [self clearHover];
    if (NSPointInRect(point, _selection) && _tool != AnnotationSelect) {
        if (_tool == AnnotationText) {
            [self beginTextAt:point];
        } else {
            if (_tool == AnnotationMosaic && _mosaic == NULL) {
                _mosaic = createMosaicImage(_desktop, self.bounds.size);
                if (_mosaic == NULL) {
                    _feedback.stringValue = @"无法生成马赛克，请重试";
                    [self updateToolbar];
                    return;
                }
            }
            _draft = [CaptureAnnotation new];
            _draft.tool = _tool;
            _draft.rgb = _annotationRGB;
            _draft.start = point;
            _draft.end = point;
        }
        return;
    }
    _selectedMark = nil;
    self.needsDisplay = YES;
    if (NSPointInRect(point, _selection)) {
        for (CaptureAnnotation *mark in _marks.reverseObjectEnumerator) {
            if ([mark hitTest:point]) {
                _selectedMark = mark;
                _movingMark = YES;
                _markInitialStart = mark.start;
                _markInitialEnd = mark.end;
                _anchor = point;
                [self updateColorButton];
                return;
            }
        }
    }
    if (event.clickCount == 2 && NSPointInRect(point, _selection)) {
        [self outputTo:DestinationCopy];
        return;
    }
    _initial = _selection;
    _anchor = point;
    _edges = [self edgesAtPoint:point];
    _moving = _edges == EdgeNone && NSPointInRect(point, _selection);
    _dragging = YES;
    if (_edges == EdgeNone && !_moving) {
        _selection = NSZeroRect;
        [_marks removeAllObjects];
        [_undoActions removeAllObjects];
        [self setTool:AnnotationSelect];
        self.needsDisplay = YES;
    }
    _feedback.stringValue = @"";
    [self updateToolbar];
}

- (void)moveByX:(CGFloat)x y:(CGFloat)y {
    NSRect bounds = self.bounds;
    _selection.origin.x = clamp(x, NSMinX(bounds), NSMaxX(bounds) - NSWidth(_selection));
    _selection.origin.y = clamp(y, NSMinY(bounds), NSMaxY(bounds) - NSHeight(_selection));
}

- (void)mouseDragged:(NSEvent *)event {
    if (_movingMark) {
        NSPoint pointer = [self pointForEvent:event];
        NSPoint target = clampPoint(NSMakePoint(_markInitialStart.x + pointer.x - _anchor.x,
                                              _markInitialStart.y + pointer.y - _anchor.y), _selection);
        _selectedMark.start = target;
        _selectedMark.end = NSMakePoint(_markInitialEnd.x + target.x - _markInitialStart.x,
                                        _markInitialEnd.y + target.y - _markInitialStart.y);
        self.needsDisplay = YES;
        return;
    }
    if (_draft != nil) {
        _draft.end = clampPoint([self pointForEvent:event], _selection);
        self.needsDisplay = YES;
        return;
    }
    if (!_dragging) {
        return;
    }
    NSPoint rawPoint = [self convertPoint:event.locationInWindow fromView:nil];
    if (!NSIsEmptyRect(_pendingSnap)) {
        if (hypot(rawPoint.x - _anchor.x, rawPoint.y - _anchor.y) < 4) {
            return;
        }
        _pendingSnap = NSZeroRect;
    }
    NSPoint point = clampPoint(rawPoint, self.bounds);
    CGFloat dx = point.x - _anchor.x;
    CGFloat dy = point.y - _anchor.y;
    if (_moving) {
        [self moveByX:NSMinX(_initial) + dx y:NSMinY(_initial) + dy];
    } else if (_edges != EdgeNone) {
        CGFloat left = NSMinX(_initial), right = NSMaxX(_initial);
        CGFloat top = NSMinY(_initial), bottom = NSMaxY(_initial);
        if (_edges & EdgeLeft) left = clamp(left + dx, 0, right - MIN(1, NSWidth(_initial)));
        if (_edges & EdgeRight) right = clamp(right + dx, left + MIN(1, NSWidth(_initial)), NSWidth(self.bounds));
        if (_edges & EdgeTop) top = clamp(top + dy, 0, bottom - MIN(1, NSHeight(_initial)));
        if (_edges & EdgeBottom) bottom = clamp(bottom + dy, top + MIN(1, NSHeight(_initial)), NSHeight(self.bounds));
        _selection = NSMakeRect(left, top, right - left, bottom - top);
    } else {
        _selection = rectBetween(_anchor, point);
    }
    self.needsDisplay = YES;
}

- (void)mouseUp:(NSEvent *)event {
    [self mouseDragged:event];
    if (_movingMark) {
        CaptureAnnotation *mark = _selectedMark;
        NSPoint start = _markInitialStart, end = _markInitialEnd;
        if (!NSEqualPoints(mark.start, start)) {
            [_undoActions addObject:^{ mark.start = start; mark.end = end; }];
        }
        _movingMark = NO;
    }
    if (_draft != nil) {
        if ([_draft isValid]) {
            [self addMark:_draft];
        }
        _draft = nil;
        self.needsDisplay = YES;
    }
    _dragging = NO;
    if (!NSIsEmptyRect(_pendingSnap)) {
        _selection = _pendingSnap;
        _pendingSnap = NSZeroRect;
        self.needsDisplay = YES;
    }
    if (CGRectIsNull([self selectionInPixels])) {
        [self clearSelection];
        [self refreshHoverAtPointer];
    }
    [self updateToolbar];
}

- (void)rightMouseDown:(NSEvent *)event { _output(DestinationCancel, nil, self.window); }

- (BOOL)performKeyEquivalent:(NSEvent *)event {
    if ((event.modifierFlags & NSEventModifierFlagCommand) && _textInput == nil) {
        NSString *key = event.charactersIgnoringModifiers.lowercaseString;
        if ([key isEqualToString:@"c"]) {
            [self outputTo:DestinationCopy];
            return YES;
        }
        if ([key isEqualToString:@"s"]) {
            [self outputTo:DestinationSave];
            return YES;
        }
        if ([key isEqualToString:@"z"] && !_dragging && !_movingMark && _draft == nil) {
            [self undoLast:nil];
            return YES;
        }
    }
    return [super performKeyEquivalent:event];
}

- (void)keyDown:(NSEvent *)event {
    NSString *chars = event.charactersIgnoringModifiers;
    if (chars.length != 1) {
        return;
    }
    unichar key = [chars characterAtIndex:0];
    if (key == 0x1b) {
        if (_palette != nil && !_palette.hidden) {
            [self togglePalette:nil];
            return;
        }
        _output(DestinationCancel, nil, self.window);
        return;
    }
    if (_dragging || _movingMark || _draft != nil) {
        return;
    }
    if (key == NSTabCharacter && NSIsEmptyRect(_selection)) {
        [_snapTargets toggleElementMode];
        return;
    }
    if (key == NSCarriageReturnCharacter || key == NSEnterCharacter) {
        [self outputTo:DestinationCopy];
        return;
    }
    if (CGRectIsNull([self selectionInPixels])) {
        return;
    }
    CGFloat step = (event.modifierFlags & NSEventModifierFlagShift) ? 10 : 1;
    // Move in image pixels, including on Retina displays.
    CGFloat dx = step * NSWidth(self.bounds) / _pixels.width;
    CGFloat dy = step * NSHeight(self.bounds) / _pixels.height;
    NSPoint origin = _selection.origin;
    switch (key) {
        case NSLeftArrowFunctionKey: origin.x -= dx; break;
        case NSRightArrowFunctionKey: origin.x += dx; break;
        case NSUpArrowFunctionKey: origin.y -= dy; break;
        case NSDownArrowFunctionKey: origin.y += dy; break;
        default: return;
    }
    [self moveByX:origin.x y:origin.y];
    self.needsDisplay = YES;
    [self updateToolbar];
}
@end
