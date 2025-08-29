//
// Mel scale
//
// Copyright (C) 2023 Andreas Gustafsson.  This file is part of
// the Gaborator library source distribution.  See the file LICENSE at
// the top level of the distribution for license information.
//

#ifndef _GABORATOR_MEL_H
#define _GABORATOR_MEL_H

#include <math.h>

namespace gaborator {

// Convert Hz to mel

static inline double hz_mel(double f_hz) {
    return 2595 * log10(1 + f_hz * (1.0 / 700));
}

// Convert mel to Hz

static inline double mel_hz(double mel) {
    return 700 * (pow(10.0, mel * (1.0 / 2595)) - 1);
}

} // namespace

#endif
