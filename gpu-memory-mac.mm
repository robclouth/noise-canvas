#import <Foundation/Foundation.h>
#import <Metal/Metal.h>
#include <string.h>
#include "gpu-memory-mac.h"

bool macGpuMemoryInfo(double *bytes, bool *unified, char *name, size_t nameSize)
{
    @autoreleasepool
    {
        id<MTLDevice> device = MTLCreateSystemDefaultDevice();
        if (!device)
            return false;
        *bytes = (double)[device recommendedMaxWorkingSetSize];
        // hasUnifiedMemory arrived in macOS 10.15; a device without it is an
        // Intel-era GPU, which reports its working set as a separate pool.
        if (@available(macOS 10.15, *))
            *unified = [device hasUnifiedMemory];
        else
            *unified = false;
        const char *deviceName = [[device name] UTF8String];
        strlcpy(name, deviceName ? deviceName : "", nameSize);
        [device release];
        return true;
    }
}
