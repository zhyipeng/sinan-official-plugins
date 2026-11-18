#include "snap-targets.h"
#include <dwmapi.h>
#include <uiautomationclient.h>
#include <algorithm>

namespace {
template<class T> class AutomationPtr {
public:
    AutomationPtr() = default;
    AutomationPtr(const AutomationPtr&) = delete;
    AutomationPtr& operator=(const AutomationPtr&) = delete;
    ~AutomationPtr() { if (value) value->Release(); }
    T* operator->() const { return value; }
    T* get() const { return value; }
    T** out() { return &value; }
    void swap(AutomationPtr& other) { std::swap(value, other.value); }
private:
    T* value{};
};

BOOL CALLBACK recordWindow(HWND window, LPARAM argument) {
    DWORD process = 0;
    GetWindowThreadProcessId(window, &process);
    if (process == GetCurrentProcessId() || !IsWindowVisible(window) || IsIconic(window) ||
        window == GetShellWindow() || window == GetDesktopWindow()) {
        return TRUE;
    }
    wchar_t name[64]{};
    GetClassNameW(window, name, 64);
    if (lstrcmpW(name, L"WorkerW") == 0 || lstrcmpW(name, L"Progman") == 0 ||
        lstrcmpW(name, L"Shell_TrayWnd") == 0 || lstrcmpW(name, L"Shell_SecondaryTrayWnd") == 0) {
        return TRUE;
    }
    DWORD cloaked = 0;
    DwmGetWindowAttribute(window, DWMWA_CLOAKED, &cloaked, sizeof(cloaked));
    RECT bounds{};
    if (cloaked || (FAILED(DwmGetWindowAttribute(window, DWMWA_EXTENDED_FRAME_BOUNDS, &bounds, sizeof(bounds))) &&
        !GetWindowRect(window, &bounds)) || bounds.right - bounds.left < 4 || bounds.bottom - bounds.top < 4) {
        return TRUE;
    }
    reinterpret_cast<std::vector<SnapWindow>*>(argument)->push_back({window, bounds});
    return TRUE;
}

bool elementRect(IUIAutomationElement* element, RECT window, POINT point, RECT& result) {
    RECT bounds;
    BOOL offscreen = TRUE;
    return SUCCEEDED(element->get_CurrentIsOffscreen(&offscreen)) && !offscreen &&
           SUCCEEDED(element->get_CurrentBoundingRectangle(&bounds)) &&
           IntersectRect(&result, &bounds, &window) &&
           result.right - result.left >= 2 && result.bottom - result.top >= 2 && PtInRect(&result, point);
}
}

std::vector<SnapWindow> snapshotWindows() {
    std::vector<SnapWindow> windows;
    EnumWindows(recordWindow, reinterpret_cast<LPARAM>(&windows));
    return windows;
}

SnapWindow windowAt(const std::vector<SnapWindow>& windows, POINT point) {
    for (const auto& window : windows) {
        if (PtInRect(&window.bounds, point)) return window;
    }
    return {};
}

std::vector<RECT> elementBounds(SnapWindow window, POINT point) {
    AutomationPtr<IUIAutomation> api;
    if (FAILED(CoCreateInstance(CLSID_CUIAutomation, nullptr, CLSCTX_INPROC_SERVER,
                                IID_IUIAutomation, reinterpret_cast<void**>(api.out())))) {
        return {};
    }
    AutomationPtr<IUIAutomation2> timeouts;
    if (SUCCEEDED(api->QueryInterface(IID_IUIAutomation2, reinterpret_cast<void**>(timeouts.out())))) {
        timeouts->put_ConnectionTimeout(140);
        timeouts->put_TransactionTimeout(100);
    }
    AutomationPtr<IUIAutomationElement> current;
    AutomationPtr<IUIAutomationTreeWalker> walker;
    // A desktop-wide point hit would find our own topmost capture overlay.
    if (FAILED(api->ElementFromHandle(window.handle, current.out())) || !current.get() ||
        FAILED(api->get_ControlViewWalker(walker.out())) || !walker.get()) {
        return {};
    }
    std::vector<RECT> found;
    unsigned budget = 80;
    const ULONGLONG started = GetTickCount64();
    for (unsigned depth = 0; depth < 10 && budget; ++depth) {
        AutomationPtr<IUIAutomationElement> child;
        if (FAILED(walker->GetFirstChildElement(current.get(), child.out()))) break;
        RECT bounds{};
        while (child.get() && budget && GetTickCount64() - started < 240) {
            --budget;
            if (elementRect(child.get(), window.bounds, point, bounds)) break;
            AutomationPtr<IUIAutomationElement> next;
            if (FAILED(walker->GetNextSiblingElement(child.get(), next.out()))) break;
            child.swap(next);
            SetRectEmpty(&bounds);
        }
        if (!child.get() || IsRectEmpty(&bounds)) break;
        if (!EqualRect(&bounds, &window.bounds) && (found.empty() || !EqualRect(&bounds, &found.back()))) {
            found.push_back(bounds);
        }
        current.swap(child);
    }
    std::reverse(found.begin(), found.end());
    if (!found.empty()) found.push_back(window.bounds);
    return found;
}
