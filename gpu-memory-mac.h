#pragma once
#include <stdbool.h>
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

/**
 * Fills in the default Metal device's recommended working-set size, whether it
 * shares system memory, and its name. Returns false when there is no device.
 */
bool macGpuMemoryInfo(double *bytes, bool *unified, char *name, size_t nameSize);

#ifdef __cplusplus
}
#endif
