// Per-region macOS vibrancy for Electron.
//
// Electron's built-in `vibrancy` is whole-window. To get the floating-splits
// look — blurred frosted glass ONLY under each panel, with the gaps showing the
// clear live desktop — we add native NSVisualEffectView subviews at the exact
// rect of each panel, on the BOTTOM of the window's view hierarchy, and keep
// the window itself transparent. The web content above must be non-opaque in
// the panel regions for the blur to show through (see index.css).
//
// API (called from the Electron MAIN process = AppKit main thread):
//   setRegions(handleBuffer, rects[], materialName) -> Number(count)
//       rect = { x, y, w, h, radius }  — top-left CSS px relative to the
//       window content view (== points; 1 CSS px ≈ 1 pt at default zoom).
//   clear(handleBuffer)
//
// Views are identified by a region index and UPSERTed (alloc once, then only
// mutate .frame) so repositioning a constantly-changing layout is cheap.

#include <napi.h>
#import <Cocoa/Cocoa.h>
#include <vector>

// NSView.tag is read-only, so we carry our own settable index on a subclass.
@interface RegionVibrancyView : NSVisualEffectView
@property (nonatomic, assign) NSInteger regionIndex;
@end
@implementation RegionVibrancyView
@end

static NSView* ViewFromHandle(const Napi::Value& val) {
  if (!val.IsBuffer()) return nil;
  auto buf = val.As<Napi::Buffer<unsigned char>>();
  if (buf.Length() < sizeof(void*)) return nil;
  // getNativeWindowHandle() returns a Buffer wrapping the NSView* (content view).
  return *reinterpret_cast<NSView* __unsafe_unretained *>(buf.Data());
}

static RegionVibrancyView* FindRegion(NSView* content, NSInteger idx) {
  for (NSView* s in content.subviews) {
    if ([s isKindOfClass:[RegionVibrancyView class]] &&
        ((RegionVibrancyView*)s).regionIndex == idx) {
      return (RegionVibrancyView*)s;
    }
  }
  return nil;
}

static NSVisualEffectMaterial MaterialFor(const std::string& name) {
  if (name == "underWindow") return NSVisualEffectMaterialUnderWindowBackground;
  if (name == "popover")     return NSVisualEffectMaterialPopover;
  if (name == "hudWindow")   return NSVisualEffectMaterialHUDWindow;
  if (name == "menu")        return NSVisualEffectMaterialMenu;
  if (name == "fullScreenUI")return NSVisualEffectMaterialFullScreenUI;
  return NSVisualEffectMaterialSidebar;  // default — matches the old window vibrancy
}

struct Region { CGRect frame; double radius; };

Napi::Value SetRegions(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  NSView* content = ViewFromHandle(info[0]);
  if (!content) return Napi::Number::New(env, 0);
  if (info.Length() < 2 || !info[1].IsArray()) return Napi::Number::New(env, 0);

  Napi::Array rects = info[1].As<Napi::Array>();
  std::string matName = (info.Length() > 2 && info[2].IsString())
      ? info[2].As<Napi::String>().Utf8Value() : "sidebar";
  NSVisualEffectMaterial material = MaterialFor(matName);

  const CGFloat H = content.bounds.size.height;
  const BOOL flipped = content.isFlipped;

  std::vector<Region> regions;
  uint32_t n = rects.Length();
  regions.reserve(n);
  for (uint32_t i = 0; i < n; i++) {
    Napi::Value rv = rects.Get(i);
    if (!rv.IsObject()) continue;
    Napi::Object r = rv.As<Napi::Object>();
    double x = r.Get("x").As<Napi::Number>().DoubleValue();
    double y = r.Get("y").As<Napi::Number>().DoubleValue();
    double w = r.Get("w").As<Napi::Number>().DoubleValue();
    double h = r.Get("h").As<Napi::Number>().DoubleValue();
    double radius = r.Has("radius") ? r.Get("radius").As<Napi::Number>().DoubleValue() : 0.0;
    if (w <= 0 || h <= 0) continue;
    // CSS is top-left origin; AppKit content view may or may not be flipped.
    CGFloat ay = flipped ? y : (H - y - h);
    regions.push_back({ CGRectMake(x, ay, w, h), radius });
  }

  uint32_t count = (uint32_t)regions.size();
  for (uint32_t i = 0; i < count; i++) {
    RegionVibrancyView* v = FindRegion(content, (NSInteger)i);
    if (!v) {
      v = [[RegionVibrancyView alloc] initWithFrame:regions[i].frame];
      v.regionIndex = (NSInteger)i;
      v.material = material;
      v.blendingMode = NSVisualEffectBlendingModeBehindWindow;
      v.state = NSVisualEffectStateActive;
      v.autoresizingMask = NSViewNotSizable;
      v.wantsLayer = YES;
      // Bottom of the hierarchy so the web content (and any WebContentsView
      // browser panes) composite ON TOP — never covered by the blur.
      [content addSubview:v positioned:NSWindowBelow relativeTo:nil];
    } else {
      v.frame = regions[i].frame;
      v.material = material;
    }
    if (regions[i].radius > 0) {
      v.layer.cornerRadius = regions[i].radius;
      v.layer.masksToBounds = YES;
    } else {
      v.layer.cornerRadius = 0;
    }
  }

  // Remove any of OUR views beyond the current count (shrunk layouts).
  NSArray* subs = [[content subviews] copy];
  for (NSView* s in subs) {
    if ([s isKindOfClass:[RegionVibrancyView class]] &&
        ((RegionVibrancyView*)s).regionIndex >= (NSInteger)count) {
      [s removeFromSuperview];
    }
  }
  return Napi::Number::New(env, count);
}

Napi::Value Clear(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  NSView* content = ViewFromHandle(info[0]);
  if (!content) return env.Undefined();
  NSArray* subs = [[content subviews] copy];
  for (NSView* s in subs) {
    if ([s isKindOfClass:[RegionVibrancyView class]]) {
      [s removeFromSuperview];
    }
  }
  return env.Undefined();
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("setRegions", Napi::Function::New(env, SetRegions));
  exports.Set("clear", Napi::Function::New(env, Clear));
  return exports;
}

NODE_API_MODULE(vibrancy, Init)
