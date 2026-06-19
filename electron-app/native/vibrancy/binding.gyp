{
  "targets": [
    {
      "target_name": "vibrancy",
      "sources": [ "vibrancy.mm" ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")"
      ],
      "defines": [ "NAPI_DISABLE_CPP_EXCEPTIONS" ],
      "conditions": [
        [ "OS=='mac'", {
          "xcode_settings": {
            "CLANG_ENABLE_OBJC_ARC": "YES",
            "MACOSX_DEPLOYMENT_TARGET": "11.0",
            "GCC_ENABLE_CPP_EXCEPTIONS": "NO",
            "OTHER_CPLUSPLUSFLAGS": [ "-std=c++17", "-fobjc-arc" ]
          },
          "link_settings": {
            "libraries": [
              "$(SDKROOT)/System/Library/Frameworks/Cocoa.framework",
              "$(SDKROOT)/System/Library/Frameworks/QuartzCore.framework"
            ]
          }
        } ]
      ]
    }
  ]
}
