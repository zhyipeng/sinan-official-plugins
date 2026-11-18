#pragma once
#include <windows.h>
#include <vector>

struct SnapWindow {
    HWND handle{};
    RECT bounds{};
};

std::vector<SnapWindow> snapshotWindows();
SnapWindow windowAt(const std::vector<SnapWindow>& windows, POINT point);
std::vector<RECT> elementBounds(SnapWindow window, POINT point);
