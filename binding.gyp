{
  "targets": [
    {
      "target_name": "gaborator_addon",
      "sources": [ "gaborator-addon.cpp" ],
      "include_dirs": [
        "node_modules/node-addon-api",
        "Gaborator-2.1"
      ],
      "cflags!": [ "-fno-exceptions" ],
      "cflags_cc!": [ "-fno-exceptions" ],
      "cflags_cc": [ "-frtti" ],
      "xcode_settings": {
        "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
        "GCC_ENABLE_CPP_RTTI": "YES",
        "CLANG_CXX_LIBRARY": "libc++",
        "MACOSX_DEPLOYMENT_TARGET": "10.7",
        "OTHER_CPLUSPLUSFLAGS": [
          "-std=c++11"
        ]
      },
      "msvs_settings": {
        "VCCLCompilerTool": {
          "ExceptionHandling": 1,
          "RuntimeTypeInfo": "true"
        }
      },
      "conditions": [
        ['OS=="mac"', {
          "defines": [ "GABORATOR_USE_VDSP=1" ],
          "link_settings": {
            "libraries": [
              "-framework Accelerate"
            ]
          }
        }]
      ]
    }
  ]
}
