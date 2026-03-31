{
    "targets": [
        {
            "target_name": "gaborator_addon",
            "sources": ["gaborator-addon.cpp"],
            "include_dirs": ["node_modules/node-addon-api", "gaborator-2.1"],
            "dependencies": ["<!(node -p \"require('node-addon-api').gyp\")"],
            "cflags!": ["-fno-exceptions"],
            "cflags_cc!": ["-fno-exceptions"],
            "cflags_cc": ["-frtti"],
            "defines": ["NAPI_DISABLE_CPP_EXCEPTIONS"],
            "xcode_settings": {
                "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
                "GCC_ENABLE_CPP_RTTI": "YES",
                "CLANG_CXX_LIBRARY": "libc++",
                "MACOSX_DEPLOYMENT_TARGET": "10.7",
                "OTHER_CPLUSPLUSFLAGS": ["-std=c++17", "-arch arm64"],
                "OTHER_LDFLAGS": ["-arch arm64"],
            },
            "msvs_settings": {
                "VCCLCompilerTool": {
                    "ExceptionHandling": 1,
                    "RuntimeTypeInfo": "true",
                    "AdditionalOptions": ["/std:c++17"],
                },
            },
            "conditions": [
                [
                    'OS=="mac"',
                    {
                        "defines": ["GABORATOR_USE_VDSP=1", "GABORATOR_ONNX_ENABLED=1"],
                        "include_dirs": ["vendor/onnxruntime/include"],
                        "link_settings": {
                            "libraries": [
                                "-framework Accelerate",
                                "<(module_root_dir)/vendor/onnxruntime/lib/libonnxruntime.dylib",
                            ],
                        },
                        "xcode_settings": {
                            "OTHER_LDFLAGS": [
                                "-arch arm64",
                                "-Wl,-rpath,@loader_path",
                            ],
                        },
                        "copies": [
                            {
                                "destination": "<(PRODUCT_DIR)",
                                "files": [
                                    "<(module_root_dir)/vendor/onnxruntime/lib/libonnxruntime.1.24.3.dylib",
                                ],
                            },
                        ],
                    },
                ],
                [
                    'OS=="win"',
                    {
                        "defines": ["_USE_MATH_DEFINES", "GABORATOR_USE_PFFFT=1"],
                        "include_dirs": ["pffft"],
                        "sources": ["pffft/pffft.c"],
                    },
                ],
                [
                    'OS=="linux"',
                    {
                        "defines": ["GABORATOR_USE_PFFFT=1"],
                        "include_dirs": ["pffft"],
                        "sources": ["pffft/pffft.c"],
                    },
                ],
            ],
        },
        {
            "target_name": "link_addon",
            "sources": ["link-addon.cpp"],
            "include_dirs": [
                "node_modules/node-addon-api",
                "vendor/link/include",
                "vendor/link/modules/asio-standalone/asio/include"
            ],
            "dependencies": ["<!(node -p \"require('node-addon-api').gyp\")"],
            "cflags!": ["-fno-exceptions"],
            "cflags_cc!": ["-fno-exceptions"],
            "cflags_cc": ["-frtti", "-std=c++17"],
            "defines": ["NAPI_DISABLE_CPP_EXCEPTIONS"],
            "xcode_settings": {
                "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
                "GCC_ENABLE_CPP_RTTI": "YES",
                "CLANG_CXX_LIBRARY": "libc++",
                "MACOSX_DEPLOYMENT_TARGET": "10.7",
                "OTHER_CPLUSPLUSFLAGS": ["-std=c++17", "-arch arm64"],
                "OTHER_LDFLAGS": ["-arch arm64"],
            },
            "msvs_settings": {
                "VCCLCompilerTool": {
                    "ExceptionHandling": 1,
                    "RuntimeTypeInfo": "true",
                    "AdditionalOptions": ["/std:c++17"],
                },
            },
            "conditions": [
                [
                    'OS=="mac"',
                    {
                        "defines": ["LINK_PLATFORM_MACOSX=1"],
                        "link_settings": {
                            "libraries": [
                                "-framework CoreAudio",
                            ],
                        },
                    },
                ],
                [
                    'OS=="win"',
                    {
                        "defines": ["LINK_PLATFORM_WINDOWS=1", "_WIN32_WINNT=0x0601"],
                        "libraries": ["-lws2_32", "-liphlpapi"],
                    },
                ],
                [
                    'OS=="linux"',
                    {
                        "defines": ["LINK_PLATFORM_LINUX=1"],
                        "libraries": ["-lpthread"],
                    },
                ],
            ],
        }
    ]
}
