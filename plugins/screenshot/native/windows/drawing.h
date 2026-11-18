#pragma once
#include <windows.h>
#include <gdiplus.h>
#include <cstdint>
#include <memory>
#include <string>
#include <vector>

enum class Tool { Select, Arrow, Rectangle, Text, Mosaic };
constexpr uint32_t defaultRGB = 0xE82B33;

struct Mark {
    Tool tool{};
    POINT start{}, end{};
    uint32_t rgb = defaultRGB;
    std::wstring text;
};

RECT regionBetween(POINT a, POINT b);
RECT markBounds(const Mark& mark, float scale);
bool validMark(const Mark& mark);
bool hitMark(const Mark& mark, POINT point, float scale);
void paintMark(Gdiplus::Graphics& graphics, const Mark& mark, const uint8_t* frozen, int stride, RECT screen, float scale);

std::vector<uint8_t> pngBytes(Gdiplus::Bitmap& bitmap);
bool copyPNG(HWND owner, Gdiplus::Bitmap& bitmap, const std::vector<uint8_t>& png);
bool writePNG(const std::wstring& destination, const std::vector<uint8_t>& png, bool replace);
