#include "drawing.h"
#include "snap-targets.h"
#include <commctrl.h>
#include <commdlg.h>
#include <imm.h>
#include <shellapi.h>
#include <windowsx.h>
#include <algorithm>
#include <array>
#include <cmath>
#include <condition_variable>
#include <cwctype>
#include <mutex>
#include <optional>
#include <thread>

using namespace Gdiplus;

namespace {
constexpr UINT snapResultMessage = WM_APP + 1;
constexpr UINT_PTR snapTimer = 1;
constexpr int escapeHotkey = 1;
constexpr int hexField = 300;
constexpr int textField = 301;
constexpr size_t outputLimit = 8 << 20;
constexpr size_t ocrLimit = 4 << 20;
constexpr long long displayPixels = 32000000;
constexpr long long snapshotPixels = 96000000;
const Color blue(0xff315ed8);

enum Button { Select = 100, Arrow, RectangleTool, Text, Mosaic, ColorButton, Undo, Copy, Save, OCR };
const std::array<const wchar_t*, 10> buttonLabels{
    L"选区或移动标注", L"箭头", L"矩形", L"文字", L"马赛克", L"标注颜色", L"撤销（Ctrl+Z）",
    L"复制（Ctrl+C）", L"保存 PNG（Ctrl+S）", L"OCR 识别",
};
constexpr int firstSwatch = 200;
constexpr std::array<uint32_t, 8> palette{defaultRGB, 0xFF8A22, 0xF4CB35, 0x21A160, 0x315ED8, 0x8E58D3, 0x20232A, 0xFFFFFF};
const std::array<const wchar_t*, 8> paletteLabels{L"红色", L"橙色", L"黄色", L"绿色", L"蓝色", L"紫色", L"黑色", L"白色"};

struct App;
struct Change {
    size_t index;
    std::optional<Mark> before;
};

struct Screen {
    App* app;
    RECT global{};
    HBITMAP dib{};
    uint8_t* pixels{};
    std::unique_ptr<Bitmap> image;
    HWND window{}, tooltip{}, text{}, hex{};
    std::array<HWND, buttonLabels.size()> buttons{};
    std::array<HWND, palette.size()> swatches{};
    RECT selection{}, initial{}, preview{}, pending{}, toolbar{}, colorBar{};
    POINT anchor{}, textAnchor{}, hoverPoint{};
    bool haveHover{}, selecting{}, shifting{}, paletteOpen{};
    int edges{}, selected{-1}, draggingMark{-1};
    float scale{1};
    Tool tool{Tool::Select};
    uint32_t rgb{defaultRGB};
    std::wstring status;
    std::vector<Mark> marks;
    std::vector<Change> history;
    std::optional<Mark> draft, original;
    SnapWindow hover{};
    unsigned revision{};
    std::vector<RECT> candidates;
    size_t candidate{};
    int wheelDelta{};

    int width() const { return global.right - global.left; }
    int height() const { return global.bottom - global.top; }
    int scaled(int points) const { return static_cast<int>(std::lround(points * scale)); }
    RECT bounds() const { return {0, 0, width(), height()}; }
    POINT clampPoint(POINT point, RECT clip) const {
        return {std::clamp(point.x, clip.left, clip.right), std::clamp(point.y, clip.top, clip.bottom)};
    }
    RECT toLocal(RECT rect) const {
        if (!IntersectRect(&rect, &rect, &global)) return {};
        OffsetRect(&rect, -global.left, -global.top);
        return rect;
    }
    uint32_t shownRGB() const {
        return selected >= 0 && marks[selected].tool != Tool::Mosaic ? marks[selected].rgb : rgb;
    }
    void repaint() const { InvalidateRect(window, nullptr, FALSE); }
};

struct Lookup {
    HWND owner;
    unsigned revision;
    SnapWindow window;
    POINT point;
};
struct Found {
    unsigned revision;
    std::vector<RECT> rects;
};

struct App {
    std::wstring output;
    bool allowOCR{}, elements{true}, saving{}, escapeRegistered{};
    std::vector<std::unique_ptr<Screen>> screens;
    std::vector<SnapWindow> windows;
    std::mutex lookupLock;
    std::condition_variable lookupReady;
    std::optional<Lookup> latest;

    void startLookupWorker() {
        std::thread([this] {
            if (FAILED(CoInitializeEx(nullptr, COINIT_MULTITHREADED))) return;
            for (;;) {
                std::unique_lock<std::mutex> lock(lookupLock);
                lookupReady.wait(lock, [this] { return latest.has_value(); });
                Lookup request = *latest;
                latest.reset();
                lock.unlock();
                auto found = std::make_unique<Found>(Found{request.revision, elementBounds(request.window, request.point)});
                if (PostMessageW(request.owner, snapResultMessage, 0, reinterpret_cast<LPARAM>(found.get()))) {
                    found.release();
                }
            }
        }).detach();
    }

    void requestLookup(Lookup request) {
        {
            std::lock_guard<std::mutex> lock(lookupLock);
            latest = request;
        }
        lookupReady.notify_one();
    }

    // The UIA worker may be inside another application's provider. Process
    // exit closes every overlay and releases native handles without joining IPC.
    [[noreturn]] void finish(UINT code) { ExitProcess(code); }
};

void clearHover(Screen& screen) {
    KillTimer(screen.window, snapTimer);
    ++screen.revision;
    screen.haveHover = false;
    screen.hover = {};
    screen.preview = {};
    screen.candidates.clear();
    screen.candidate = 0;
    screen.wheelDelta = 0;
}

void refreshHover(Screen& screen, POINT local) {
    RECT full = screen.bounds();
    if (!IsRectEmpty(&screen.selection) || screen.selecting || !PtInRect(&full, local)) {
        if (screen.haveHover) {
            clearHover(screen);
            screen.repaint();
        }
        return;
    }
    POINT point{local.x + screen.global.left, local.y + screen.global.top};
    SnapWindow window = windowAt(screen.app->windows, point);
    if (screen.haveHover && window.handle == screen.hover.handle &&
        std::hypot(point.x - screen.hoverPoint.x, point.y - screen.hoverPoint.y) < 3) return;
    RECT old = screen.preview;
    bool keep = window.handle && window.handle == screen.hover.handle && PtInRect(&screen.preview, local);
    clearHover(screen);
    screen.haveHover = true;
    screen.hover = window;
    screen.hoverPoint = point;
    screen.preview = keep ? old : screen.toLocal(window.bounds);
    if (window.handle && screen.app->elements) SetTimer(screen.window, snapTimer, 55, nullptr);
    if (!EqualRect(&old, &screen.preview)) screen.repaint();
}

void acceptCandidates(Screen& screen, const Found& result) {
    if (screen.revision != result.revision || !screen.haveHover || !screen.app->elements) return;
    screen.candidates.clear();
    for (auto value : result.rects) {
        RECT local = screen.toLocal(value);
        if (!IsRectEmpty(&local) && (screen.candidates.empty() || !EqualRect(&local, &screen.candidates.back()))) {
            screen.candidates.push_back(local);
        }
    }
    screen.candidate = 0;
    screen.preview = screen.candidates.empty() ? screen.toLocal(screen.hover.bounds) : screen.candidates.front();
    screen.repaint();
}

void addTooltip(Screen& screen, HWND control, const wchar_t* label) {
    if (!screen.tooltip) {
        screen.tooltip = CreateWindowExW(WS_EX_TOPMOST, TOOLTIPS_CLASSW, nullptr, WS_POPUP | TTS_ALWAYSTIP,
                                        CW_USEDEFAULT, CW_USEDEFAULT, CW_USEDEFAULT, CW_USEDEFAULT,
                                        screen.window, nullptr, GetModuleHandleW(nullptr), nullptr);
    }
    TTTOOLINFOW info{};
    info.cbSize = sizeof(info);
    info.uFlags = TTF_IDISHWND | TTF_SUBCLASS;
    info.hwnd = screen.window;
    info.uId = reinterpret_cast<UINT_PTR>(control);
    info.lpszText = const_cast<wchar_t*>(label);
    SendMessageW(screen.tooltip, TTM_ADDTOOLW, 0, reinterpret_cast<LPARAM>(&info));
}

HWND createButton(Screen& screen, int id, const wchar_t* label) {
    HWND button = CreateWindowExW(0, L"BUTTON", label, WS_CHILD | BS_OWNERDRAW,
                                  0, 0, 0, 0, screen.window, reinterpret_cast<HMENU>(static_cast<INT_PTR>(id)),
                                  GetModuleHandleW(nullptr), nullptr);
    if (button) addTooltip(screen, button, label);
    return button;
}

void positionControls(Screen& screen) {
    const bool visible = !screen.selecting && !IsRectEmpty(&screen.selection);
    if (visible && !screen.buttons[0]) {
        for (size_t i = 0; i < screen.buttons.size(); ++i) {
            screen.buttons[i] = createButton(screen, Select + static_cast<int>(i), buttonLabels[i]);
        }
        EnableWindow(screen.buttons[OCR - Select], screen.app->allowOCR);
    }
    const int side = screen.scaled(31), padding = screen.scaled(5), gap = screen.scaled(7);
    const int width = side * static_cast<int>(screen.buttons.size()) + 2 * padding, height = side + 2 * padding;
    int x = std::clamp(static_cast<int>(screen.selection.right) - width, 0, std::max(0, screen.width() - width));
    int y = screen.selection.bottom + gap;
    if (y + height > screen.height()) y = std::max(0, static_cast<int>(screen.selection.top) - height - gap);
    screen.toolbar = visible ? RECT{x, y, x + width, y + height} : RECT{};
    for (size_t i = 0; i < screen.buttons.size(); ++i) {
        if (!screen.buttons[i]) continue;
        SetWindowPos(screen.buttons[i], nullptr, x + padding + side * static_cast<int>(i), y + padding, side, side,
                     SWP_NOZORDER | SWP_NOACTIVATE | (visible ? SWP_SHOWWINDOW : SWP_HIDEWINDOW));
        InvalidateRect(screen.buttons[i], nullptr, TRUE);
    }
    if (screen.buttons[Undo - Select]) EnableWindow(screen.buttons[Undo - Select], !screen.history.empty());

    const bool paletteVisible = visible && screen.paletteOpen;
    int swatchWidth = screen.scaled(24), hexWidth = screen.scaled(80);
    int paletteWidth = swatchWidth * static_cast<int>(palette.size()) + hexWidth + 3 * padding;
    int paletteX = std::max(0, x + width - paletteWidth);
    int paletteY = y + height + gap;
    if (paletteY + height > screen.height()) paletteY = std::max(0, y - height - gap);
    screen.colorBar = paletteVisible ? RECT{paletteX, paletteY, paletteX + paletteWidth, paletteY + height} : RECT{};
    for (size_t i = 0; i < screen.swatches.size(); ++i) {
        if (!screen.swatches[i]) continue;
        SetWindowPos(screen.swatches[i], nullptr, paletteX + padding + swatchWidth * static_cast<int>(i),
                     paletteY + padding, swatchWidth, side,
                     SWP_NOZORDER | SWP_NOACTIVATE | (paletteVisible ? SWP_SHOWWINDOW : SWP_HIDEWINDOW));
    }
    if (screen.hex) {
        SetWindowPos(screen.hex, nullptr, paletteX + paletteWidth - hexWidth - padding, paletteY + padding,
                     hexWidth, side, SWP_NOZORDER | SWP_NOACTIVATE | (paletteVisible ? SWP_SHOWWINDOW : SWP_HIDEWINDOW));
    }
    screen.repaint();
}

void drawIcon(Graphics& graphics, int id, Color ink, uint32_t rgb) {
    Pen pen(ink, 1.6f);
    pen.SetLineJoin(LineJoinRound);
    pen.SetStartCap(LineCapRound);
    pen.SetEndCap(LineCapRound);
    auto line = [&](int a, int b, int c, int d) { graphics.DrawLine(&pen, a, b, c, d); };
    auto corners = [&] {
        line(9, 4, 4, 4); line(4, 4, 4, 9); line(21, 9, 21, 4); line(21, 4, 16, 4);
        line(4, 16, 4, 21); line(4, 21, 9, 21); line(16, 21, 21, 21); line(21, 21, 21, 16);
    };
    switch (id) {
    case Select: corners(); break;
    case Arrow: line(5, 20, 20, 5); line(10, 5, 20, 5); line(20, 5, 20, 15); break;
    case RectangleTool: graphics.DrawRectangle(&pen, 4, 6, 17, 13); break;
    case Text: line(5, 6, 20, 6); line(12, 6, 12, 20); line(8, 20, 16, 20); break;
    case Mosaic:
        for (int y : {4, 11, 18}) for (int x : {4, 11, 18}) graphics.DrawRectangle(&pen, x, y, 3, 3);
        break;
    case Undo:
        line(12, 3, 5, 10); line(5, 10, 12, 17); line(5, 10, 14, 10);
        graphics.DrawArc(&pen, 9, 10, 11, 11, -90, 180); break;
    case Copy:
        graphics.DrawRectangle(&pen, 5, 8, 12, 12);
        line(8, 5, 20, 5); line(20, 5, 20, 17); break;
    case Save:
        line(12, 4, 12, 16); line(7, 11, 12, 16); line(17, 11, 12, 16); line(5, 21, 20, 21); break;
    case OCR: corners(); line(7, 9, 17, 9); line(7, 13, 17, 13); line(7, 17, 14, 17); break;
    default: {
        SolidBrush fill(Color(0xff000000 | rgb));
        graphics.FillRectangle(&fill, 6, 6, 13, 13);
        graphics.DrawRectangle(&pen, 6, 6, 13, 13);
        break;
    }
    }
}

void paintButton(Screen& screen, const DRAWITEMSTRUCT& item) {
    const int id = static_cast<int>(item.CtlID);
    bool selected = id >= Select && id <= Mosaic && static_cast<int>(screen.tool) == id - Select;
    bool press = (item.itemState & ODS_SELECTED) != 0;
    Graphics graphics(item.hDC);
    graphics.SetSmoothingMode(SmoothingModeAntiAlias);
    SolidBrush bg(selected || press ? Color(0xffe9efff) : Color(0xfff7f8fc));
    const auto& button = item.rcItem;
    graphics.FillRectangle(&bg, Rect(button.left, button.top, button.right - button.left, button.bottom - button.top));
    float scale = std::min(button.right - button.left, button.bottom - button.top) * .69f / 25;
    graphics.TranslateTransform((button.right - 25 * scale) / 2, (button.bottom - 25 * scale) / 2);
    graphics.ScaleTransform(scale, scale);
    Color ink = (item.itemState & ODS_DISABLED) ? Color(0xff9da5b5) :
                selected || id == Copy ? blue : Color(0xff263147);
    uint32_t rgb = id >= firstSwatch && id < firstSwatch + static_cast<int>(palette.size()) ?
                   palette[id - firstSwatch] : screen.shownRGB();
    drawIcon(graphics, id, ink, rgb);
    if (item.itemState & ODS_FOCUS) DrawFocusRect(item.hDC, &item.rcItem);
}

void paintMarks(Screen& screen, Graphics& graphics) {
    GraphicsState previous = graphics.Save();
    auto rect = screen.selection;
    graphics.SetClip(Rect(rect.left, rect.top, rect.right - rect.left, rect.bottom - rect.top), CombineModeIntersect);
    for (const auto& mark : screen.marks) paintMark(graphics, mark, screen.pixels, screen.width() * 4, screen.bounds(), screen.scale);
    if (screen.draft) paintMark(graphics, *screen.draft, screen.pixels, screen.width() * 4, screen.bounds(), screen.scale);
    graphics.Restore(previous);
}

void paintScreen(Screen& screen, HDC dc) {
    Graphics graphics(dc);
    graphics.SetSmoothingMode(SmoothingModeAntiAlias);
    graphics.DrawImage(screen.image.get(), Rect(0, 0, screen.width(), screen.height()),
                       0, 0, screen.width(), screen.height(), UnitPixel);
    RECT chosen = !IsRectEmpty(&screen.selection) ? screen.selection :
                  !IsRectEmpty(&screen.pending) ? screen.pending : screen.preview;
    Region shade(Rect(0, 0, screen.width(), screen.height()));
    if (!IsRectEmpty(&chosen)) shade.Exclude(Rect(chosen.left, chosen.top, chosen.right - chosen.left, chosen.bottom - chosen.top));
    SolidBrush dim(Color(106, 0, 0, 0));
    graphics.FillRegion(&dim, &shade);

    if (!IsRectEmpty(&screen.selection)) paintMarks(screen, graphics);
    Pen outline(blue, 1.5f * screen.scale);
    if (!IsRectEmpty(&chosen)) {
        graphics.DrawRectangle(&outline, Rect(chosen.left, chosen.top, chosen.right - chosen.left - 1, chosen.bottom - chosen.top - 1));
    }
    if (!IsRectEmpty(&screen.selection)) {
        SolidBrush handles(blue);
        const int radius = screen.scaled(3);
        for (LONG x : {chosen.left, chosen.right}) for (LONG y : {chosen.top, chosen.bottom}) {
            graphics.FillRectangle(&handles, Rect(x - radius, y - radius, radius * 2, radius * 2));
        }
    }
    if (screen.selected >= 0) {
        RECT mark = markBounds(screen.marks[screen.selected], screen.scale);
        InflateRect(&mark, screen.scaled(4), screen.scaled(4));
        outline.SetDashStyle(DashStyleDash);
        graphics.DrawRectangle(&outline, Rect(mark.left, mark.top, mark.right - mark.left, mark.bottom - mark.top));
    }
    SolidBrush bar(Color(0xfff7f8fc));
    for (auto box : {screen.toolbar, screen.colorBar}) {
        if (!IsRectEmpty(&box)) graphics.FillRectangle(&bar, Rect(box.left, box.top, box.right - box.left, box.bottom - box.top));
    }

    std::wstring label = screen.status;
    if (label.empty() && !IsRectEmpty(&screen.selection)) {
        label = std::to_wstring(chosen.right - chosen.left) + L" × " + std::to_wstring(chosen.bottom - chosen.top);
    }
    if (label.empty()) {
        label = screen.app->elements ? L"元素吸附  ·  滚轮切换候选  ·  Tab 切回窗口" : L"窗口吸附  ·  单击选取或拖动框选  ·  Tab 切换";
    }
    Font font(L"Segoe UI", 13 * screen.scale, FontStyleRegular, UnitPixel);
    RectF measured{};
    graphics.MeasureString(label.c_str(), -1, &font, PointF(0, 0), &measured);
    float pad = 7 * screen.scale;
    float x = IsRectEmpty(&screen.selection) ? (screen.width() - measured.Width) / 2 :
              std::clamp(static_cast<float>(chosen.left) + pad, pad, std::max(pad, screen.width() - measured.Width - pad));
    float y = IsRectEmpty(&screen.selection) ? screen.height() - measured.Height - 24 * screen.scale :
              std::max(pad, static_cast<float>(chosen.top) - measured.Height - 2 * pad);
    SolidBrush badge(Color(232, 30, 36, 47)), white(Color::White);
    graphics.FillRectangle(&badge, x - pad, y - pad / 2, measured.Width + 2 * pad, measured.Height + pad);
    graphics.DrawString(label.c_str(), -1, &font, PointF(x, y), &white);
}

void addMark(Screen& screen, Mark mark) {
    screen.history.push_back({screen.marks.size(), std::nullopt});
    screen.marks.push_back(std::move(mark));
}

void endText(Screen& screen, bool accept) {
    if (!screen.text) return;
    HWND input = screen.text;
    screen.text = nullptr;
    if (accept) {
        std::array<wchar_t, 1025> value{};
        int length = GetWindowTextW(input, value.data(), static_cast<int>(value.size()));
        if (length > 0) addMark(screen, {Tool::Text, screen.textAnchor, {}, screen.rgb, value.data()});
    }
    DestroyWindow(input);
    SetFocus(screen.window);
    positionControls(screen);
}

void applyColor(Screen& screen, uint32_t rgb) {
    screen.rgb = rgb;
    if (screen.selected >= 0) {
        auto& mark = screen.marks[screen.selected];
        if (mark.tool != Tool::Mosaic && mark.rgb != rgb) {
            screen.history.push_back({static_cast<size_t>(screen.selected), mark});
            mark.rgb = rgb;
        }
    }
    screen.paletteOpen = false;
    screen.status.clear();
    SetFocus(screen.window);
    positionControls(screen);
}

bool commitHex(Screen& screen) {
    wchar_t text[9]{};
    GetWindowTextW(screen.hex, text, 9);
    std::wstring value(text);
    if (!value.empty() && value.front() == L'#') value.erase(0, 1);
    if (value.size() != 6 || !std::all_of(value.begin(), value.end(), [](wchar_t ch) {
        return (ch >= L'0' && ch <= L'9') || (ch >= L'a' && ch <= L'f') || (ch >= L'A' && ch <= L'F');
    })) {
        screen.status = L"请输入 6 位十六进制颜色";
        screen.repaint();
        return false;
    }
    applyColor(screen, static_cast<uint32_t>(std::wcstoul(value.c_str(), nullptr, 16)));
    return true;
}

LRESULT CALLBACK editProc(HWND edit, UINT message, WPARAM key, LPARAM arg, UINT_PTR id, DWORD_PTR context) {
    auto& screen = *reinterpret_cast<Screen*>(context);
    if (message == WM_CHAR && (key == VK_RETURN || key == VK_ESCAPE)) return 0;
    if (message == WM_KEYDOWN && (key == VK_RETURN || key == VK_ESCAPE)) {
        HIMC ime = ImmGetContext(edit);
        bool composing = ime && ImmGetCompositionStringW(ime, GCS_COMPSTR, nullptr, 0) > 0;
        if (ime) ImmReleaseContext(edit, ime);
        if (!composing) {
            if (id == textField) endText(screen, key == VK_RETURN);
            else if (key == VK_RETURN) commitHex(screen);
            else {
                screen.paletteOpen = false;
                screen.status.clear();
                SetFocus(screen.window);
                positionControls(screen);
            }
            return 0;
        }
    }
    return DefSubclassProc(edit, message, key, arg);
}

HWND createEdit(Screen& screen, int id) {
    HWND edit = CreateWindowExW(WS_EX_CLIENTEDGE, L"EDIT", nullptr, WS_CHILD | ES_AUTOHSCROLL,
                                0, 0, 0, 0, screen.window, reinterpret_cast<HMENU>(static_cast<INT_PTR>(id)),
                                GetModuleHandleW(nullptr), nullptr);
    if (edit) {
        SendMessageW(edit, WM_SETFONT, reinterpret_cast<WPARAM>(GetStockObject(DEFAULT_GUI_FONT)), FALSE);
        SendMessageW(edit, EM_SETLIMITTEXT, id == hexField ? 7 : 1024, 0);
        SetWindowSubclass(edit, editProc, id, reinterpret_cast<DWORD_PTR>(&screen));
    }
    return edit;
}

void showPalette(Screen& screen) {
    screen.paletteOpen = !screen.paletteOpen;
    if (screen.paletteOpen) {
        if (!screen.hex) {
            screen.hex = createEdit(screen, hexField);
            if (screen.hex) addTooltip(screen, screen.hex, L"输入 #RRGGBB 后按回车");
            for (size_t i = 0; i < palette.size(); ++i) {
                screen.swatches[i] = createButton(screen, firstSwatch + static_cast<int>(i), paletteLabels[i]);
            }
        }
        wchar_t hex[8]{};
        swprintf(hex, std::size(hex), L"#%06X", screen.shownRGB());
        SetWindowTextW(screen.hex, hex);
    }
    SetFocus(screen.window);
    positionControls(screen);
}

void startText(Screen& screen, POINT point) {
    screen.textAnchor = point;
    screen.text = createEdit(screen, textField);
    if (!screen.text) return;
    int width = std::min(screen.scaled(240), screen.width()), height = screen.scaled(28);
    SetWindowPos(screen.text, HWND_TOP, std::clamp<int>(point.x, 0, screen.width() - width),
                 std::clamp<int>(point.y, 0, screen.height() - height), width, height, SWP_SHOWWINDOW);
    SendMessageW(screen.text, EM_SETCUEBANNER, FALSE, reinterpret_cast<LPARAM>(L"输入文字，回车确认"));
    SetFocus(screen.text);
}

void undo(Screen& screen) {
    if (screen.history.empty()) return;
    auto change = std::move(screen.history.back());
    screen.history.pop_back();
    if (change.before) screen.marks[change.index] = std::move(*change.before);
    else screen.marks.erase(screen.marks.begin() + change.index);
    if (screen.selected >= 0 && static_cast<size_t>(screen.selected) >= screen.marks.size()) screen.selected = -1;
    screen.status.clear();
    positionControls(screen);
}

void resetSelection(Screen& screen) {
    endText(screen, false);
    screen.selection = screen.pending = {};
    screen.selected = screen.draggingMark = -1;
    screen.tool = Tool::Select;
    screen.selecting = screen.paletteOpen = false;
    screen.marks.clear();
    screen.history.clear();
    screen.draft.reset();
    screen.original.reset();
    screen.status.clear();
    clearHover(screen);
    positionControls(screen);
}

int edgeFlags(Screen& screen, POINT point) {
    RECT box = screen.selection, margin = box;
    const int tolerance = screen.scaled(6);
    InflateRect(&margin, tolerance, tolerance);
    if (IsRectEmpty(&box) || !PtInRect(&margin, point)) return 0;
    int flags = 0;
    LONG left = std::abs(point.x - box.left), right = std::abs(point.x - box.right);
    LONG top = std::abs(point.y - box.top), bottom = std::abs(point.y - box.bottom);
    if (std::min(left, right) <= tolerance) flags |= left <= right ? 1 : 2;
    if (std::min(top, bottom) <= tolerance) flags |= top <= bottom ? 4 : 8;
    return flags;
}

void beginDrag(Screen& screen, POINT point) {
    for (auto& other : screen.app->screens) {
        if (other.get() != &screen && !IsRectEmpty(&other->selection)) resetSelection(*other);
    }
    endText(screen, true);
    screen.status.clear();
    screen.paletteOpen = false;
    SetFocus(screen.window);
    screen.anchor = point;
    RECT pending = screen.preview;
    clearHover(screen);
    screen.pending = {};
    if (PtInRect(&screen.selection, point) && screen.tool != Tool::Select) {
        if (screen.tool == Tool::Text) {
            positionControls(screen);
            startText(screen, point);
        } else {
            screen.draft = Mark{screen.tool, point, point, screen.rgb, {}};
            SetCapture(screen.window);
            positionControls(screen);
        }
        return;
    }
    screen.selected = -1;
    if (PtInRect(&screen.selection, point)) {
        for (size_t i = screen.marks.size(); i > 0; --i) {
            if (hitMark(screen.marks[i - 1], point, screen.scale)) {
                screen.selected = screen.draggingMark = static_cast<int>(i - 1);
                screen.original = screen.marks[i - 1];
                SetCapture(screen.window);
                positionControls(screen);
                return;
            }
        }
    }
    screen.edges = edgeFlags(screen, point);
    screen.shifting = !screen.edges && PtInRect(&screen.selection, point);
    if (!screen.edges && !screen.shifting) {
        if (IsRectEmpty(&screen.selection) && PtInRect(&pending, point)) screen.pending = pending;
        screen.selection = {};
        screen.marks.clear();
        screen.history.clear();
        screen.tool = Tool::Select;
    }
    screen.initial = screen.selection;
    screen.selecting = true;
    SetCapture(screen.window);
    positionControls(screen);
}

void shiftSelection(Screen& screen, LONG x, LONG y) {
    RECT box = screen.initial;
    LONG width = box.right - box.left, height = box.bottom - box.top;
    x = std::clamp(x, 0L, static_cast<LONG>(screen.width()) - width);
    y = std::clamp(y, 0L, static_cast<LONG>(screen.height()) - height);
    screen.selection = {x, y, x + width, y + height};
}

void drag(Screen& screen, POINT point) {
    if (screen.draggingMark >= 0) {
        auto& mark = screen.marks[screen.draggingMark];
        auto start = screen.original->start;
        mark.start = screen.clampPoint({start.x + point.x - screen.anchor.x, start.y + point.y - screen.anchor.y}, screen.selection);
        mark.end = {screen.original->end.x + mark.start.x - start.x, screen.original->end.y + mark.start.y - start.y};
    } else if (screen.draft) {
        screen.draft->end = screen.clampPoint(point, screen.selection);
    } else if (screen.selecting) {
        if (!IsRectEmpty(&screen.pending) &&
            std::hypot(point.x - screen.anchor.x, point.y - screen.anchor.y) < screen.scaled(4)) return;
        screen.pending = {};
        point = screen.clampPoint(point, screen.bounds());
        LONG dx = point.x - screen.anchor.x, dy = point.y - screen.anchor.y;
        RECT box = screen.initial;
        if (screen.shifting) {
            shiftSelection(screen, box.left + dx, box.top + dy);
        } else if (screen.edges) {
            if (screen.edges & 1) box.left = std::clamp(box.left + dx, 0L, box.right - 1);
            if (screen.edges & 2) box.right = std::clamp(box.right + dx, box.left + 1, static_cast<LONG>(screen.width()));
            if (screen.edges & 4) box.top = std::clamp(box.top + dy, 0L, box.bottom - 1);
            if (screen.edges & 8) box.bottom = std::clamp(box.bottom + dy, box.top + 1, static_cast<LONG>(screen.height()));
            screen.selection = box;
        } else {
            screen.selection = regionBetween(screen.anchor, point);
        }
    } else {
        refreshHover(screen, point);
        return;
    }
    screen.repaint();
}

void endDrag(Screen& screen, POINT point) {
    if (screen.selecting || screen.draft || screen.draggingMark >= 0) drag(screen, point);
    if (screen.draggingMark >= 0) {
        const auto& mark = screen.marks[screen.draggingMark];
        if (mark.start.x != screen.original->start.x || mark.start.y != screen.original->start.y) {
            screen.history.push_back({static_cast<size_t>(screen.draggingMark), std::move(screen.original)});
        }
        screen.original.reset();
        screen.draggingMark = -1;
    }
    if (screen.draft && validMark(*screen.draft)) addMark(screen, std::move(*screen.draft));
    screen.draft.reset();
    screen.selecting = false;
    if (!IsRectEmpty(&screen.pending)) {
        screen.selection = screen.pending;
        screen.pending = {};
    }
    if (screen.selection.right - screen.selection.left < 2 || screen.selection.bottom - screen.selection.top < 2) {
        screen.selection = {};
        refreshHover(screen, point);
    }
    ReleaseCapture();
    positionControls(screen);
}

void registerEscape(App& app) {
    app.escapeRegistered = RegisterHotKey(nullptr, escapeHotkey, MOD_NOREPEAT, VK_ESCAPE);
}

std::wstring askDestination(Screen& screen) {
    App& app = *screen.app;
    app.saving = true;
    if (app.escapeRegistered) {
        UnregisterHotKey(nullptr, escapeHotkey);
        app.escapeRegistered = false;
    }
    for (const auto& monitor : app.screens) ShowWindow(monitor->window, SW_HIDE);
    std::array<wchar_t, 32768> name{L'截', L'图', L'.', L'p', L'n', L'g'};
    OPENFILENAMEW dialog{};
    dialog.lStructSize = sizeof(dialog);
    dialog.hwndOwner = screen.window;
    dialog.lpstrFilter = L"PNG 图片 (*.png)\0*.png\0";
    dialog.lpstrFile = name.data();
    dialog.nMaxFile = static_cast<DWORD>(name.size());
    dialog.lpstrDefExt = L"png";
    dialog.Flags = OFN_PATHMUSTEXIST | OFN_OVERWRITEPROMPT | OFN_NOCHANGEDIR | OFN_EXPLORER;
    bool confirmed = GetSaveFileNameW(&dialog);
    for (const auto& monitor : app.screens) ShowWindow(monitor->window, SW_SHOWNOACTIVATE);
    SetForegroundWindow(screen.window);
    SetFocus(screen.window);
    registerEscape(app);
    app.saving = false;
    return confirmed ? std::wstring(name.data()) : std::wstring();
}

void output(Screen& screen, int button) {
    if (IsRectEmpty(&screen.selection) || screen.selecting || screen.draft || screen.draggingMark >= 0 ||
        (button == OCR && !screen.app->allowOCR)) return;
    endText(screen, true);
    const RECT region = screen.selection;
    const auto width = region.right - region.left, height = region.bottom - region.top;
    Bitmap image(width, height, PixelFormat32bppARGB);
    if (image.GetLastStatus() != Ok) {
        screen.status = L"无法生成截图";
        screen.repaint();
        return;
    }
    {
        Graphics graphics(&image);
        graphics.SetSmoothingMode(SmoothingModeAntiAlias);
        graphics.DrawImage(screen.image.get(), Rect(0, 0, width, height), region.left, region.top, width, height, UnitPixel);
        graphics.TranslateTransform(-static_cast<float>(region.left), -static_cast<float>(region.top));
        paintMarks(screen, graphics);
    }
    auto png = pngBytes(image);
    if (png.empty()) screen.status = L"无法生成 PNG";
    else if (png.size() > (button == OCR ? ocrLimit : outputLimit)) {
        screen.status = button == OCR ? L"OCR 图片超过 4 MiB，请缩小选区" : L"截图超过 8 MiB，请缩小选区";
    } else if (button == Copy) {
        if (copyPNG(screen.window, image, png)) screen.app->finish(0);
        screen.status = L"复制失败，请重试";
    } else if (button == Save) {
        auto path = askDestination(screen);
        if (!path.empty() && writePNG(path, png, true)) screen.app->finish(0);
        screen.status = path.empty() ? L"" : L"保存失败，请重试";
    } else {
        if (writePNG(screen.app->output, png, false)) screen.app->finish(8);
        screen.status = L"无法准备 OCR 图片，请重试";
    }
    screen.repaint();
}

void command(Screen& screen, int id) {
    if (id == ColorButton) { showPalette(screen); return; }
    if (id >= firstSwatch && id < firstSwatch + static_cast<int>(palette.size())) {
        applyColor(screen, palette[id - firstSwatch]);
        return;
    }
    endText(screen, true);
    if (id >= Select && id <= Mosaic) {
        screen.tool = static_cast<Tool>(id - Select);
        screen.selected = -1;
        screen.paletteOpen = false;
        screen.status.clear();
        positionControls(screen);
    } else if (id == Undo) {
        undo(screen);
    } else if (id == Copy || id == Save || id == OCR) {
        output(screen, id);
    }
    SetFocus(screen.window);
}

void keyDown(Screen& screen, WPARAM key) {
    if (key == VK_ESCAPE) {
        if (screen.paletteOpen) showPalette(screen);
        else screen.app->finish(2);
        return;
    }
    if (key == VK_TAB && IsRectEmpty(&screen.selection)) {
        screen.app->elements = !screen.app->elements;
        POINT cursor{};
        GetCursorPos(&cursor);
        for (const auto& item : screen.app->screens) {
            clearHover(*item);
            POINT point{cursor.x - item->global.left, cursor.y - item->global.top};
            refreshHover(*item, point);
            item->repaint();
        }
        return;
    }
    if (screen.selecting || screen.draggingMark >= 0 || screen.draft) return;
    bool control = (GetKeyState(VK_CONTROL) & 0x8000) != 0;
    if (key == VK_RETURN || (control && key == 'C')) output(screen, Copy);
    else if (control && key == 'S') output(screen, Save);
    else if (control && key == 'Z') undo(screen);
    else if (!IsRectEmpty(&screen.selection) && key >= VK_LEFT && key <= VK_DOWN) {
        LONG step = GetKeyState(VK_SHIFT) & 0x8000 ? 10 : 1;
        screen.initial = screen.selection;
        shiftSelection(screen, screen.selection.left + (key == VK_RIGHT ? step : key == VK_LEFT ? -step : 0),
                       screen.selection.top + (key == VK_DOWN ? step : key == VK_UP ? -step : 0));
        positionControls(screen);
    }
}

LRESULT CALLBACK windowProc(HWND window, UINT message, WPARAM wparam, LPARAM lparam) {
    if (message == WM_NCCREATE) {
        auto* screen = static_cast<Screen*>(reinterpret_cast<CREATESTRUCTW*>(lparam)->lpCreateParams);
        screen->window = window;
        SetWindowLongPtrW(window, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(screen));
    }
    auto* screen = reinterpret_cast<Screen*>(GetWindowLongPtrW(window, GWLP_USERDATA));
    if (!screen) return DefWindowProcW(window, message, wparam, lparam);
    POINT point{GET_X_LPARAM(lparam), GET_Y_LPARAM(lparam)};
    switch (message) {
    case WM_ERASEBKGND: return 1;
    case WM_PAINT: {
        PAINTSTRUCT paint;
        HDC dc = BeginPaint(window, &paint);
        paintScreen(*screen, dc);
        EndPaint(window, &paint);
        return 0;
    }
    case WM_DRAWITEM:
        paintButton(*screen, *reinterpret_cast<DRAWITEMSTRUCT*>(lparam));
        return TRUE;
    case WM_COMMAND:
        if (HIWORD(wparam) == BN_CLICKED) command(*screen, LOWORD(wparam));
        return 0;
    case WM_LBUTTONDOWN: beginDrag(*screen, point); return 0;
    case WM_LBUTTONUP: endDrag(*screen, point); return 0;
    case WM_LBUTTONDBLCLK:
        if (screen->tool == Tool::Select && PtInRect(&screen->selection, point)) output(*screen, Copy);
        else beginDrag(*screen, point);
        return 0;
    case WM_RBUTTONDOWN:
    case WM_CLOSE:
    case WM_DISPLAYCHANGE:
    case WM_DPICHANGED: screen->app->finish(2);
    case WM_MOUSEMOVE: {
        TRACKMOUSEEVENT event{sizeof(event), TME_LEAVE, window, 0};
        TrackMouseEvent(&event);
        drag(*screen, point);
        return 0;
    }
    case WM_MOUSELEAVE:
        clearHover(*screen);
        screen->repaint();
        return 0;
    case WM_MOUSEWHEEL:
        if (screen->candidates.size() > 1 && IsRectEmpty(&screen->selection)) {
            screen->wheelDelta += GET_WHEEL_DELTA_WPARAM(wparam);
            if (std::abs(screen->wheelDelta) >= WHEEL_DELTA) {
                size_t count = screen->candidates.size();
                screen->candidate = (screen->candidate + (screen->wheelDelta > 0 ? 1 : count - 1)) % count;
                screen->wheelDelta = 0;
                screen->preview = screen->candidates[screen->candidate];
                screen->repaint();
            }
        }
        return 0;
    case WM_KEYDOWN: keyDown(*screen, wparam); return 0;
    case WM_TIMER:
        if (wparam == snapTimer) {
            KillTimer(window, snapTimer);
            if (screen->hover.handle && screen->app->elements) {
                screen->app->requestLookup({window, screen->revision, screen->hover, screen->hoverPoint});
            }
        }
        return 0;
    case snapResultMessage: {
        std::unique_ptr<Found> result(reinterpret_cast<Found*>(lparam));
        acceptCandidates(*screen, *result);
        return 0;
    }
    }
    return DefWindowProcW(window, message, wparam, lparam);
}

BOOL CALLBACK monitorProc(HMONITOR, HDC, LPRECT frame, LPARAM data) {
    auto& app = *reinterpret_cast<App*>(data);
    auto screen = std::make_unique<Screen>();
    screen->app = &app;
    screen->global = *frame;
    app.screens.push_back(std::move(screen));
    return TRUE;
}

bool freezeScreens(App& app) {
    HDC desktop = GetDC(nullptr);
    if (!desktop) return false;
    HDC dc = CreateCompatibleDC(desktop);
    bool ok = dc != nullptr;
    for (const auto& monitor : app.screens) {
        if (!ok) break;
        auto& screen = *monitor;
        BITMAPINFO info{};
        info.bmiHeader.biSize = sizeof(info.bmiHeader);
        info.bmiHeader.biWidth = screen.width();
        info.bmiHeader.biHeight = -screen.height();
        info.bmiHeader.biPlanes = 1;
        info.bmiHeader.biBitCount = 32;
        void* pixels = nullptr;
        screen.dib = CreateDIBSection(desktop, &info, DIB_RGB_COLORS, &pixels, nullptr, 0);
        screen.pixels = static_cast<uint8_t*>(pixels);
        if (!screen.dib || !screen.pixels) { ok = false; break; }
        HGDIOBJ previous = SelectObject(dc, screen.dib);
        ok = BitBlt(dc, 0, 0, screen.width(), screen.height(), desktop, screen.global.left, screen.global.top, SRCCOPY | CAPTUREBLT);
        SelectObject(dc, previous);
        if (ok) {
            screen.image = std::make_unique<Bitmap>(screen.width(), screen.height(), screen.width() * 4,
                                                    PixelFormat32bppRGB, screen.pixels);
            ok = screen.image->GetLastStatus() == Ok;
        }
    }
    if (dc) DeleteDC(dc);
    ReleaseDC(nullptr, desktop);
    return ok;
}

bool testDrawing() {
    auto reverse = regionBetween({16, 24}, {3, 4});
    RECT expected{3, 4, 16, 24};
    if (!EqualRect(&reverse, &expected)) return false;
    auto first = reinterpret_cast<HWND>(1), second = reinterpret_cast<HWND>(2);
    std::vector<SnapWindow> windows{{first, {-20, 5, 20, 40}}, {second, {-50, -8, 160, 120}}};
    if (windowAt(windows, {-5, 12}).handle != first || windowAt(windows, {25, 12}).handle != second) return false;

    GdiplusStartupInput input;
    ULONG_PTR gdiplus{};
    if (FAILED(OleInitialize(nullptr)) || GdiplusStartup(&gdiplus, &input, nullptr) != Ok) return false;
    bool valid;
    {
        Bitmap image(100, 70, PixelFormat32bppARGB);
        {
            Graphics graphics(&image);
            graphics.Clear(Color::White);
            Mark rectangle{Tool::Rectangle, {9, 13}, {47, 41}, 0x315ED8, {}};
            Mark arrow{Tool::Arrow, {11, 59}, {67, 59}, 0xE82B33, {}};
            paintMark(graphics, rectangle, nullptr, 0, RECT{}, 1);
            paintMark(graphics, arrow, nullptr, 0, RECT{}, 1);
        }
        Color rectangle{}, arrow{};
        auto encoded = pngBytes(image);
        valid = image.GetPixel(20, 13, &rectangle) == Ok && rectangle.GetValue() == 0xff315ed8 &&
                image.GetPixel(19, 59, &arrow) == Ok && arrow.GetValue() == 0xffe82b33 &&
                encoded.size() > 8 && encoded[0] == 0x89 && encoded[1] == 'P';
    }
    GdiplusShutdown(gdiplus);
    OleUninitialize();
    return valid;
}

VOID CALLBACK parentStopped(PVOID, BOOLEAN) { ExitProcess(2); }

} // namespace

int WINAPI wWinMain(HINSTANCE instance, HINSTANCE, PWSTR, int) {
    int count = 0;
    LPWSTR* args = CommandLineToArgvW(GetCommandLineW(), &count);
    if (!args) return 6;
    if (count == 2 && lstrcmpW(args[1], L"--self-test") == 0) {
        LocalFree(args);
        return testDrawing() ? 0 : 1;
    }
    if (count != 3 && count != 4) {
        LocalFree(args);
        return 6;
    }
    App app;
    app.output = args[1];
    wchar_t* remaining = nullptr;
    unsigned long pid = std::wcstoul(args[2], &remaining, 10);
    app.allowOCR = count == 4 && lstrcmpW(args[3], L"ocr") == 0;
    bool valid = pid && remaining && !*remaining && (count != 4 || app.allowOCR);
    LocalFree(args);
    if (!valid) return 6;
    HANDLE parent = OpenProcess(SYNCHRONIZE, FALSE, pid), parentWait = nullptr;
    if (!parent || !RegisterWaitForSingleObject(&parentWait, parent, parentStopped, nullptr, INFINITE, WT_EXECUTEONLYONCE)) return 2;

    if (!SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2))
        SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    GdiplusStartupInput configuration;
    ULONG_PTR gdiplus = 0;
    if (FAILED(OleInitialize(nullptr)) || GdiplusStartup(&gdiplus, &configuration, nullptr) != Ok) return 5;
    INITCOMMONCONTROLSEX controls{sizeof(controls), ICC_WIN95_CLASSES};
    InitCommonControlsEx(&controls);
    EnumDisplayMonitors(nullptr, nullptr, monitorProc, reinterpret_cast<LPARAM>(&app));
    if (app.screens.empty()) return 5;
    long long total = 0;
    for (const auto& screen : app.screens) {
        long long pixels = static_cast<long long>(screen->width()) * screen->height();
        if (pixels <= 0 || pixels > displayPixels || (total += pixels) > snapshotPixels) return 7;
    }
    if (!freezeScreens(app)) return 5;
    app.windows = snapshotWindows();

    WNDCLASSW type{};
    type.hInstance = instance;
    type.lpszClassName = L"SinanScreenshotOverlay";
    type.lpfnWndProc = windowProc;
    type.hCursor = LoadCursorW(nullptr, IDC_CROSS);
    type.style = CS_DBLCLKS;
    if (!RegisterClassW(&type)) return 5;
    POINT cursor{};
    GetCursorPos(&cursor);
    HWND key{};
    for (auto& item : app.screens) {
        auto& screen = *item;
        HWND window = CreateWindowExW(WS_EX_TOOLWINDOW | WS_EX_TOPMOST, type.lpszClassName, L"司南截图",
            WS_POPUP | WS_CLIPCHILDREN, screen.global.left, screen.global.top, screen.width(), screen.height(),
            nullptr, nullptr, instance, &screen);
        if (!window) return 5;
        UINT dpi = GetDpiForWindow(window);
        screen.scale = dpi ? dpi / 96.f : 1.f;
        if (!key || PtInRect(&screen.global, cursor)) key = window;
    }
    app.startLookupWorker();
    for (auto& screen : app.screens) {
        ShowWindow(screen->window, SW_SHOWNOACTIVATE);
        if (PtInRect(&screen->global, cursor)) {
            refreshHover(*screen, {cursor.x - screen->global.left, cursor.y - screen->global.top});
        }
    }
    if (key) {
        SetForegroundWindow(key);
        SetFocus(key);
    }
    registerEscape(app);
    MSG message{};
    while (GetMessageW(&message, nullptr, 0, 0) > 0) {
        if (message.message == WM_HOTKEY && message.wParam == escapeHotkey && !app.saving) {
            HWND keyWindow = GetFocus();
            auto active = std::find_if(app.screens.begin(), app.screens.end(), [&](const auto& item) {
                return item->window == keyWindow || IsChild(item->window, keyWindow);
            });
            if (active != app.screens.end() && (*active)->text) endText(**active, false);
            else if (active != app.screens.end() && (*active)->paletteOpen) showPalette(**active);
            else app.finish(2);
        }
        TranslateMessage(&message);
        DispatchMessageW(&message);
    }
    app.finish(2);
}
