#include "drawing.h"
#include <objidl.h>
#include <algorithm>
#include <cmath>
#include <cstring>
#include <memory>

using namespace Gdiplus;

RECT regionBetween(POINT a, POINT b) {
    return {std::min(a.x, b.x), std::min(a.y, b.y), std::max(a.x, b.x), std::max(a.y, b.y)};
}

RECT markBounds(const Mark& mark, float scale) {
    if (mark.tool == Tool::Text) {
        Bitmap scratch(1, 1);
        Graphics graphics(&scratch);
        Font font(L"Segoe UI", 20 * scale, FontStyleBold, UnitPixel);
        RectF bounds{};
        graphics.MeasureString(mark.text.c_str(), static_cast<INT>(mark.text.size()), &font,
                               PointF(static_cast<float>(mark.start.x), static_cast<float>(mark.start.y)), &bounds);
        return {mark.start.x, mark.start.y, static_cast<LONG>(std::ceil(bounds.GetRight())),
                static_cast<LONG>(std::ceil(bounds.GetBottom()))};
    }
    return regionBetween(mark.start, mark.end);
}

bool validMark(const Mark& mark) {
    if (mark.tool == Tool::Text) return !mark.text.empty();
    if (mark.tool == Tool::Arrow) return std::hypot(mark.end.x - mark.start.x, mark.end.y - mark.start.y) >= 3;
    RECT bounds = regionBetween(mark.start, mark.end);
    return bounds.right - bounds.left >= 2 && bounds.bottom - bounds.top >= 2;
}

bool hitMark(const Mark& mark, POINT point, float scale) {
    const LONG tolerance = static_cast<LONG>(std::ceil(6 * scale));
    RECT bounds = markBounds(mark, scale), expanded = bounds;
    InflateRect(&expanded, tolerance, tolerance);
    if (!PtInRect(&expanded, point)) return false;
    if (mark.tool == Tool::Rectangle) {
        InflateRect(&bounds, -tolerance, -tolerance);
        return !PtInRect(&bounds, point);
    }
    if (mark.tool == Tool::Arrow) {
        double dx = mark.end.x - mark.start.x, dy = mark.end.y - mark.start.y;
        double fraction = std::clamp(((point.x - mark.start.x) * dx + (point.y - mark.start.y) * dy) /
                                     (dx * dx + dy * dy), 0.0, 1.0);
        return std::hypot(point.x - mark.start.x - fraction * dx, point.y - mark.start.y - fraction * dy) <= tolerance;
    }
    return true;
}

void paintMark(Graphics& graphics, const Mark& mark, const uint8_t* frozen, int stride, RECT screen, float scale) {
    if (!validMark(mark)) return;
    Color color(0xFF000000 | mark.rgb);
    SolidBrush fill(color);
    RECT box = regionBetween(mark.start, mark.end);
    switch (mark.tool) {
    case Tool::Rectangle: {
        Pen pen(color, 3 * scale);
        pen.SetLineJoin(LineJoinRound);
        graphics.DrawRectangle(&pen, Rect(box.left, box.top, box.right - box.left, box.bottom - box.top));
        break;
    }
    case Tool::Arrow: {
        Pen pen(color, 3 * scale);
        pen.SetStartCap(LineCapRound);
        pen.SetEndCap(LineCapRound);
        graphics.DrawLine(&pen, Point(mark.start.x, mark.start.y), Point(mark.end.x, mark.end.y));
        float dx = static_cast<float>(mark.end.x - mark.start.x), dy = static_cast<float>(mark.end.y - mark.start.y);
        float length = std::hypot(dx, dy);
        float head = std::min(13 * scale, length * .45f);
        dx *= head / length;
        dy *= head / length;
        graphics.DrawLine(&pen, static_cast<float>(mark.end.x) - dx - dy * .5f,
                          static_cast<float>(mark.end.y) - dy + dx * .5f,
                          static_cast<float>(mark.end.x), static_cast<float>(mark.end.y));
        graphics.DrawLine(&pen, static_cast<float>(mark.end.x) - dx + dy * .5f,
                          static_cast<float>(mark.end.y) - dy - dx * .5f,
                          static_cast<float>(mark.end.x), static_cast<float>(mark.end.y));
        break;
    }
    case Tool::Text: {
        Font font(L"Segoe UI", 20 * scale, FontStyleBold, UnitPixel);
        const double luminance = (mark.rgb >> 16) * .2126 + ((mark.rgb >> 8) & 255) * .7152 + (mark.rgb & 255) * .0722;
        SolidBrush outline(luminance > 184 ? Color::Black : Color::White);
        const auto x = static_cast<float>(mark.start.x), y = static_cast<float>(mark.start.y);
        const INT length = static_cast<INT>(mark.text.size());
        for (const auto& offset : {PointF(-1, 0), PointF(1, 0), PointF(0, -1), PointF(0, 1)}) {
            graphics.DrawString(mark.text.c_str(), length, &font, PointF(x + offset.X, y + offset.Y), &outline);
        }
        graphics.DrawString(mark.text.c_str(), length, &font, PointF(x, y), &fill);
        break;
    }
    case Tool::Mosaic: {
        RECT clipped;
        if (!IntersectRect(&clipped, &box, &screen)) return;
        int step = std::max(2, static_cast<int>(12 * scale));
        for (LONG y = clipped.top; y < clipped.bottom; y += step) {
            for (LONG x = clipped.left; x < clipped.right; x += step) {
                LONG endX = std::min(clipped.right, x + step), endY = std::min(clipped.bottom, y + step);
                const uint8_t* pixel = frozen + ((y + endY) / 2 - screen.top) * stride +
                                       ((x + endX) / 2 - screen.left) * 4;
                SolidBrush cell(Color(pixel[2], pixel[1], pixel[0]));
                graphics.FillRectangle(&cell, Rect(x, y, endX - x, endY - y));
            }
        }
        break;
    }
    case Tool::Select: break;
    }
}

std::vector<uint8_t> pngBytes(Bitmap& bitmap) {
    constexpr CLSID encoder = {0x557cf406, 0x1a04, 0x11d3, {0x9a, 0x73, 0, 0, 0xf8, 0x1e, 0xf3, 0x2e}};
    IStream* raw = nullptr;
    if (FAILED(CreateStreamOnHGlobal(nullptr, TRUE, &raw))) return {};
    auto release = [](IStream* stream) { stream->Release(); };
    std::unique_ptr<IStream, decltype(release)> stream(raw, release);
    STATSTG stats{};
    HGLOBAL buffer = nullptr;
    if (bitmap.Save(raw, &encoder, nullptr) != Ok || FAILED(raw->Stat(&stats, STATFLAG_NONAME)) ||
        stats.cbSize.QuadPart == 0 || stats.cbSize.QuadPart > MAXDWORD ||
        FAILED(GetHGlobalFromStream(raw, &buffer))) return {};
    auto* bytes = static_cast<const uint8_t*>(GlobalLock(buffer));
    if (!bytes) return {};
    std::vector<uint8_t> output(bytes, bytes + stats.cbSize.QuadPart);
    GlobalUnlock(buffer);
    return output;
}

bool copyPNG(HWND owner, Bitmap& bitmap, const std::vector<uint8_t>& png) {
    UINT pngFormat = RegisterClipboardFormatW(L"PNG");
    if (!pngFormat) return false;
    HGLOBAL encoded = GlobalAlloc(GMEM_MOVEABLE, png.size());
    if (!encoded) return false;
    void* output = GlobalLock(encoded);
    if (!output) {
        GlobalFree(encoded);
        return false;
    }
    std::memcpy(output, png.data(), png.size());
    GlobalUnlock(encoded);

    // Provide a DIB alongside PNG for applications that only read standard clipboard formats.
    size_t stride = static_cast<size_t>(bitmap.GetWidth()) * 4;
    HGLOBAL dib = GlobalAlloc(GMEM_MOVEABLE | GMEM_ZEROINIT, sizeof(BITMAPV5HEADER) + stride * bitmap.GetHeight());
    if (dib) {
        auto* header = static_cast<BITMAPV5HEADER*>(GlobalLock(dib));
        Rect rect(0, 0, bitmap.GetWidth(), bitmap.GetHeight());
        BitmapData data{};
        bool locked = header && bitmap.LockBits(&rect, ImageLockModeRead, PixelFormat32bppARGB, &data) == Ok;
        if (locked) {
            header->bV5Size = sizeof(*header);
            header->bV5Width = rect.Width;
            header->bV5Height = -rect.Height;
            header->bV5Planes = 1;
            header->bV5BitCount = 32;
            header->bV5Compression = BI_BITFIELDS;
            header->bV5RedMask = 0x00ff0000;
            header->bV5GreenMask = 0x0000ff00;
            header->bV5BlueMask = 0x000000ff;
            header->bV5AlphaMask = 0xff000000;
            header->bV5CSType = LCS_sRGB;
            auto* pixels = reinterpret_cast<uint8_t*>(header + 1);
            for (INT y = 0; y < rect.Height; ++y) {
                auto* row = static_cast<uint8_t*>(data.Scan0) + static_cast<ptrdiff_t>(y) * data.Stride;
                std::memcpy(pixels + static_cast<size_t>(y) * stride, row, stride);
            }
            bitmap.UnlockBits(&data);
        }
        if (header) GlobalUnlock(dib);
        if (!locked) {
            GlobalFree(dib);
            dib = nullptr;
        }
    }
    bool copied = false;
    if (OpenClipboard(owner)) {
        if (EmptyClipboard()) {
            copied = SetClipboardData(pngFormat, encoded) != nullptr;
            if (dib && SetClipboardData(CF_DIBV5, dib)) dib = nullptr;
        }
        CloseClipboard();
    }
    if (!copied) GlobalFree(encoded);
    if (dib) GlobalFree(dib);
    return copied;
}

bool writePNG(const std::wstring& destination, const std::vector<uint8_t>& png, bool replace) {
    std::wstring path = destination;
    if (replace) {
        GUID id{};
        wchar_t suffix[40]{};
        if (FAILED(CoCreateGuid(&id)) || !StringFromGUID2(id, suffix, 40)) return false;
        path += suffix;
        path += L".tmp";
    }
    HANDLE file = CreateFileW(path.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (file == INVALID_HANDLE_VALUE) return false;
    DWORD written = 0;
    bool ok = WriteFile(file, png.data(), static_cast<DWORD>(png.size()), &written, nullptr) && written == png.size();
    CloseHandle(file);
    if (ok && replace) ok = MoveFileExW(path.c_str(), destination.c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH);
    if (!ok) DeleteFileW(path.c_str());
    return ok;
}
