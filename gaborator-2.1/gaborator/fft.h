//
// Fast Fourier transform
//
// Copyright (C) 2016-2023 Andreas Gustafsson.  This file is part of
// the Gaborator library source distribution.  See the file LICENSE at
// the top level of the distribution for license information.
//

#ifndef _GABORATOR_FFT_H
#define _GABORATOR_FFT_H

#if GABORATOR_USE_VDSP
#include "gaborator/fft_vdsp.h"
#define GABORATOR_MIN_FFT_SIZE 1
#elif GABORATOR_USE_PFFFT
#include "gaborator/fft_pffft.h"
#define GABORATOR_MIN_FFT_SIZE 32
#else

// Use the naive FFT
#include "gaborator/fft_naive.h"
#define GABORATOR_MIN_FFT_SIZE 1
#endif

#endif
