{
  "targets": [
    {
      "target_name": "gaborator_addon",
      "sources": [ "gaborator-addon.cpp" ],

      "include_dirs": [
        "node_modules/node-addon-api",
        "gaborator-2.1"
      ],
      "dependencies": [
        "<!(node -p \"require('node-addon-api').gyp\")"
      ],
      "cflags!": [ "-fno-exceptions" ],
      "cflags_cc!": [ "-fno-exceptions" ],
      "defines": [ "NAPI_DISABLE_CPP_EXCEPTIONS" ],
      "xcode_settings": {
        "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
        "GCC_ENABLE_CPP_RTTI": "YES",
        "CLANG_CXX_LIBRARY": "libc++",
        "MACOSX_DEPLOYMENT_TARGET": "10.7",
        "OTHER_CPLUSPLUSFLAGS": [ "-std=c++17" ]
      },
      "msvs_settings": {
        "VCCLCompilerTool": {
          "ExceptionHandling": 1,
          "AdditionalOptions": [ "/std:c++17" ]
        }
      },
      "conditions": [
        ['OS=="mac"', {
          "defines": [ "GABORATOR_USE_VDSP=1" ],
          "link_settings": {
            "libraries": [ "-framework Accelerate" ]
          }
        }],
        ['OS=="win"', {
          "defines": [
            "_USE_MATH_DEFINES",
            "GABORATOR_USE_PFFFT=1"
          ],
          "include_dirs": [ "pffft" ],
          "sources": [ "pffft/pffft.c" ]
        }],
        ['OS=="linux"', {
          "defines": [ "GABORATOR_USE_PFFFT=1" ],
          "include_dirs": [ "pffft" ],
          "sources": [ "pffft/pffft.c" ]
        }]
      ]
    }
  ]
}