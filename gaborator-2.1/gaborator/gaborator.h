//
// Constant Q spectrum analysis and synthesis
//
// Copyright (C) 2015-2024 Andreas Gustafsson.  This file is part of
// the Gaborator library source distribution.  See the file LICENSE at
// the top level of the distribution for license information.
//

#ifndef _GABORATOR_GABORATOR_H
#define _GABORATOR_GABORATOR_H

#include <assert.h>
#include <errno.h>
#include <inttypes.h>
#include <limits.h>
#include <math.h>
#include <stdint.h>
#include <stdio.h>

#include <algorithm>
#include <complex>
#include <limits>
#include <map>
#include <memory>
#include <typeinfo>
#include <vector>

#include "gaborator/affine_transform.h"
#include "gaborator/fft.h"
#include "gaborator/gaussian.h"
#include "gaborator/mel.h"
#include "gaborator/pod_vector.h"
#include "gaborator/pool.h"
#include "gaborator/mel.h"
#include "gaborator/ref.h"
#include "gaborator/vector_math.h"


#ifndef GABORATOR_N_BIG_PLANS
#define GABORATOR_N_BIG_PLANS 2
#endif

namespace gaborator {

using std::complex;

// An integer identifying an audio sample
typedef int64_t sample_index_t;

// An integer identifying a coefficient
typedef int64_t coef_index_t;

// An integer identifying a slice
typedef int64_t slice_index_t;

// See https://tauday.com/tau-manifesto
static const double tau = 2.0 * M_PI;

static const double overlap_default = 0.7;
static const double max_error_default = 1e-5;
static const int eq_dir_default = 1;

// Square

template <class T>
T sqr(T x) {
    return x * x;
}

// Round up to next higher or equal power of 2

static inline int
next_power_of_two(int x) {
    --x;
    x |= x >> 1;
    x |= x >> 2;
    x |= x >> 4;
    x |= x >> 8;
    x |= x >> 16;
    return x + 1;
}

// Determine if x is a power of two.
// Note that this considers 0 to be a power of two.

static inline bool
is_power_of_two(unsigned int x) {
    return (x & (x - 1)) == 0;
}

// Given a power of two v, determine log2(v)
// https://graphics.stanford.edu/~seander/bithacks.html#DetermineIfPowerOf2

static inline unsigned int whichp2(unsigned int v) {
    assert(is_power_of_two(v));
    unsigned int r = (v & 0xAAAAAAAA) != 0;
    r |= ((v & 0xCCCCCCCC) != 0) << 1;
    r |= ((v & 0xF0F0F0F0) != 0) << 2;
    r |= ((v & 0xFF00FF00) != 0) << 3;
    r |= ((v & 0xFFFF0000) != 0) << 4;
    return r;
}

// Floor division: return the integer part of a / b
// rounded down (not towards zero).  For positive b only.

static inline int64_t
floor_div(int64_t a, int64_t b) {
    assert(b > 0);
    if (a >= 0)
        return a / b;
    else
        return (a - b + 1) / b;
}

// Floating point modulus, the remainder r of a / b
// satisfying 0 <= r < b even for negative a.
// For positive b only.

static inline double
sane_fmod(double a, double b) {
    assert(b > 0);
    double m = fmod(a, b);
    if (m < 0)
        m += b;
    return m;
}

static inline bool
integerp(double x) {
    return x == floor(x);
}

// Do an arithmetic left shift of a 64-bit signed integer.  This is
// what a << b ought to do, but according to the C++11 draft (n3337),
// section 5.8, that invokes undefined behavior when a is negative.
// GCC is actually smart enough to optimize this into a single shlq
// instruction.
//
// No corresponding kludge is needed for right shifts, because a right
// shift of a negative signed integer is implementation-defined, not
// undefined, and we trust implementations to define it sanely.

static inline int64_t
shift_left(int64_t a, unsigned int b) {
    if (a < 0)
        return -(((uint64_t) -a) << b);
    else
        return (((uint64_t) a) << b);
}

// Return a >> b where the discarded bits must all be zeros

template <class T>
static inline T shift_right_exact(T a, int b) {
    assert((a & ((1 << b) - 1)) == 0);
    return a >> b;
}

// Convert between complex types

template <class T, class U>
complex<T> c2c(complex<U> c) { return complex<T>(c.real(), c.imag()); }

// Convert a sequence of complex values to real

template <class I, class O>
O complex2real(I b, I e, O o) {
    while (b != e) {
        *o++ = (*b++).real();
    }
    return o;
}

// Assignment operator like versions of std::min and std::max

template <class T>
void set_min(T &a, const T &b) {
    a = std::min(a, b);
}

template <class T>
void set_max(T &a, const T &b) {
    a = std::max(a, b);
}

template <class T>
struct resource_pool {
    typedef complex<T> C;
    // Complex FFTs
    pool<fft<C *>, int> ft;
    // Real FFTs
    pool<rfft<C *>, int> rft;
};

template <class T>
resource_pool<T> *
default_resource_pool() {
    static resource_pool<T> shared;
    return &shared;
}

// A vector-like object that allows arbitrary integer indices
// (positive or negative, but excluding the largest possible integer)
// and automatically resizes the storage.  Uses storage proportional
// to the difference between the smallest and largest index value (for
// example, if indices range from -102 to -100 (inclusive), memory use
// is on the order of 3 elements).
//
// T is the element type
// I is the integer index type

template <class T, class I = int>
struct range_vector {
    typedef T value_type;
    typedef I index_type;

    range_vector() {
        init_bounds();
    }
    range_vector(const range_vector &) = delete;
    range_vector &operator=(const range_vector &rhs) = delete;
    range_vector(range_vector &&rhs):
        v(std::move(rhs.v)),
        lower(rhs.lower),
        upper(rhs.upper)
    {
        rhs.init_bounds();
    }
    range_vector &operator=(range_vector &&rhs) {
        if (this == &rhs)
            return *this;
        v = std::move(rhs.v);
        lower = rhs.lower;
        upper = rhs.upper;
        rhs.init_bounds();
        return *this;
    }
private:
    void init_bounds() {
        lower = std::numeric_limits<I>::max();
        upper = std::numeric_limits<I>::min();
    }
    T *unchecked_get(I i) {
        return &v[(size_t)(i & ((I)v.size() - 1))];
    }
    const T *unchecked_get(I i) const {
        return &v[i & ((I)v.size() - 1)];
    }

public:
    // Get a pointer to an existing element, or null if out of range
    const T *
    get(I i) const {
        if (! has_index(i))
            return 0;
        return unchecked_get(i);
    }

    // Note: Reference returned becomes invalid when range_vector
    // is changed
    T &
    get_or_create(I i) {
        if (! has_index(i))
            extend(i);
        return *unchecked_get(i);

    }

    // Get a reference to the element at index i, which must be valid
    T &
    get_existing(I i) {
        assert(has_index(i));
        return *unchecked_get(i);
    }

    // Const version of the above
    const T &
    get_existing(I i) const {
        assert(has_index(i));
        return *unchecked_get(i);
    }

    // For compatibility with existing array algorithms; not currently
    // used by the Gaborator itself
    T &
    operator[](I i) {
        return get_or_create(i);
    }
    const T &
    operator[](I i) const {
        return get_existing(i);
    }
private:
    void extend(I i) {
        I new_lower = lower;
        I new_upper = upper;
        if (i < lower)
            new_lower = i;
        if (i + 1 > upper)
            new_upper = i + 1;
        I old_size = v.size();
        I new_need = new_upper - new_lower;
        if (new_need > old_size) {
            if (old_size == 0) {
                v.resize(1);
            } else {
                I new_size = old_size;
                while (new_size < new_need)
                    new_size *= 2;
                v.resize(new_size);
                if (old_size) {
                    for (I j = lower; j < upper; j++) {
                        I jo = j & (old_size - 1);
                        I jn = j & (new_size - 1);
                        if (jo != jn)
                            std::swap(v[jo], v[jn]);
                    }
                }
            }
        }
        lower = new_lower;
        upper = new_upper;
    }

public:
    // Erase the elements whose index is less than "limit"
    void erase_before(I limit) {
        I i = lower;
        for (; i < upper && i < limit; i++)
            *unchecked_get(i) = T();
        lower = i;
    }

    void clear() {
        v.clear();
        init_bounds();
    }

    I begin_index() const { return lower; }
    I end_index() const { return upper; }
    bool empty() const { return lower >= upper; }
    bool has_index(I i) const { return i >= lower && i < upper; }

private:
    std::vector<T> v;
    I lower, upper;
};

// Calculate the size of the alias-free part (the "filet")
// of a signal slice of size "fftsize"

static inline unsigned int filet_part(unsigned int fftsize) {
    return fftsize >> 1;
}

// Calculate the size of the padding (the "fat") at each
// end of a signal slice of size "fftsize"

static inline unsigned fat_part(unsigned int fftsize) {
    return fftsize >> 2;
}

// Per-band, per-plan data

template <class T>
struct band_plan {
    typedef complex<T> C;
    unsigned int sftsize; // Size of "short FFT" spanning the band
    unsigned int sftsize_log2; // log2(sftsize)
    fft<C *> *sft; // Fourier transform for windows, of size sftsize
    // Frequency domain kernels for analysis and synthesis direction
    struct dir_t {
        // Analysis/reconstruction filter
        std::vector<T> kernel;
        // Complex exponential for fractional frequency compensation
        pod_vector<C> shift_kernel;
    } dir[2];
    // Frequency offset in bins (big-FFT bin of left window edge).
    // Can be negative.
    int fq_offset_int;
    double center; // Center frequency in units of FFT bins
    int icenter; // Center frequency rounded to nearest integer FFT bin
};

// Frequency band parameters shared between the octaves in a zone

template <class T>
struct band_params: public refcounted {
    bool dc; // True iff this is the lowpass (DC) band
    double ff; // Center (bp) or corner (lp) frequency in units of the sample rate
    double ffsd; // Standard deviation of the bandpass Gaussian, as fractional frequency
    int step_log2; // log2(octave subsamples per coefficient)
    double ff_support; // Filter support in frequency domain
    // Per-direction part
    struct {
        double time_support; // Filter support in time domain, in octave subsamples
        std::vector<band_plan<T>> plans;
    } dir[2];
};

// Forward declarations
template <class T> struct analyzer;
template <class T> struct zone;
template <class T, class C = complex<T>> struct coefs;
template <class C> struct sliced_coefs;
template <class T, class OI = complex<T> *, class C = complex<T>>
    struct row_source;
template <class T, class II = complex<T> *, class C = complex<T>>
    struct row_dest;
template <class T, class II = complex<T> *, class C = complex<T>>
    struct row_add_dest;

struct coefs_meta;

// Per-band coefficient metadata

struct band_coefs_meta {
    int oct; // Octave / band group
    int obno; // Band number within group
};

// Per-octave coefficient metadata.
// Cf. struct octave

struct oct_coefs_meta {
    coefs_meta *cmeta; // Back pointer
    int step_log2;
    unsigned int n_bands; // Number of bands in this octave
    // The total number of bands in higher-frequency groups;
    // also the first band number in this group.
    unsigned int n_bands_above;
};

// Coefficient metadata for multirate coefficients.

struct coefs_meta: public refcounted {
    coefs_meta() = default;
    coefs_meta(const coefs_meta &) = delete;
    int n_octaves;
    unsigned int n_bands_total; // mirrors bands.size()
    unsigned int n_bandpass_bands_total;
    int slice_len_log2; // log2(coefficient samples per slice)
    std::vector<band_coefs_meta> bands;
    std::vector<oct_coefs_meta> octaves;
};

// Split a global band number "gbno" into an octave number "oct" and a
// band number within the octave "obno" per the coefficient octave
// structure.
//
// Global band numbers start at 0 for the band at or close to fs/2,
// and increase towards lower frequencies.
//
// Include the DC band if "dc" is true.
// Returns true iff gbno is valid.

static inline bool
bno_split(const coefs_meta &meta, int gbno, int &oct, unsigned int &obno,
          bool dc)
{
    if (gbno < 0 || gbno >= (int) meta.bands.size())
        return false;
    if (! dc && gbno >= (int) meta.n_bandpass_bands_total)
        return false;
    const band_coefs_meta &bi(meta.bands[gbno]);
    oct = bi.oct;
    obno = bi.obno;
    return true;
}

// The inverse of bno_split().  Returns a gbno.  The arguments must be
// valid.

static inline
int bno_merge(const coefs_meta &meta, int oct, unsigned int obno) {
    assert(oct < meta.n_octaves);
    return obno + meta.octaves[oct].n_bands_above;
}

// Coefficients of a single octave for a single input signal slice.
// C is the coefficient type, typically complex<float> but can also
// be e.g. unsigned int to store cluster numbers, or float to store
// magnitudes.

template <class C>
struct oct_coefs {
    oct_coefs(const oct_coefs_meta &ometa_, bool clear_ = true):
        ometa(ometa_),
        data(total_size()),
        bands(*this)
    {
        if (clear_)
            clear();
    }
    oct_coefs(const oct_coefs &) = delete;
    oct_coefs &operator=(const oct_coefs &rhs) = delete;

    // Size as a number of coefficients, not bytes
    size_t total_size() const {
        return ometa.n_bands * (1 << ometa.cmeta->slice_len_log2);
    }
    uint64_t estimate_memory_usage() const {
        return total_size() * sizeof(C) + sizeof(*this);
    }
    void clear() {
        std::fill(data.begin(), data.end(), C());
    }

    const oct_coefs_meta &ometa;

    // The data for all the bands are allocated together
    // as a single vector to reduce the number of allocations
    pod_vector<C> data;
    // Vector-like collection of pointers into "data", one for each band
    struct band_array {
        band_array(oct_coefs &outer_): outer(outer_) { }
        C *operator[](size_t i) const {
            return outer.data.data() + i * (1 << outer.ometa.cmeta->slice_len_log2);
        }
        size_t size() const { return outer.ometa.n_bands; }
        oct_coefs &outer;
    } bands;
};

// Add the oct_coefs "b" to the oct_coefs "a"

template <class C>
void add(oct_coefs<C> &a, const oct_coefs<C> &b) {
    size_t n_bands = a.bands.size();
    assert(n_bands == b.bands.size());
    for (size_t obno = 0; obno < n_bands; obno++) {
        unsigned int len = 1 << a.ometa.cmeta->slice_len_log2;
        C *band_a = a.bands[obno];
        C *band_b = b.bands[obno];
        for (unsigned int j = 0; j < len; j++) {
            band_a[j] += band_b[j];
        }
    }
}

// Sliced coefficients.  These cover an arbitrary time range, but only
// a single octave.  Template argument is as for struct oct_coefs.
// This is default constructible so that we can create an array of
// them, but not usable until "meta" has been set up.

template <class C>
struct sliced_coefs {
    typedef range_vector<std::unique_ptr<oct_coefs<C>>, slice_index_t> slices_t;
    sliced_coefs():
        ometa(0)
    { }
    sliced_coefs(const sliced_coefs &) = delete;
    sliced_coefs(sliced_coefs &&c):
        ometa(c.ometa),
        slices(std::move(c.slices))
    { }

    uint64_t estimate_memory_usage() const {
        unsigned int n = 0;
        size_t size_each = 0;
        for (slice_index_t sl = slices.begin_index(); sl < slices.end_index(); sl++) {
            const auto &t = slices.get_existing(sl);
            if (t) {
                if (! size_each)
                    size_each = (size_t)t->estimate_memory_usage();
                n++;
            }
        }
        return n * size_each;
    }
    void clear() {
        slices.clear();
    }
    oct_coefs<C> *make() const {
        return new oct_coefs<C>(*ometa);
    }
    oct_coefs_meta *ometa;
    slices_t slices;
};

// Get a pointer to an existing coefficient slice, or null if one does
// not exist.  This hides the distinction between two types of
// nonexistence: that of slices outside the range of the range_vector,
// and that of missing slices within the range (having a null ref).
//
// The template argument SC can refer to the sliced_coefs type, or
// some other type of sliced data, such as subsampled audio.

template <class SC>
typename SC::slices_t::value_type::pointer
get_existing_ptr(const SC &sc, typename SC::slices_t::index_type i) {
    // p is a pointer to a smart pointer, or null
    const typename SC::slices_t::value_type *p = sc.slices.get(i);
    // If the slice is missing, return null
    if (! p)
        return 0;
    // Return the value of the smart pointer, which can also be null
    return p->get();
}

// Get an existing coefficient slice, or create a new one.  Like
// get_exising_ptr(), this hides the distinction between slices
// outside the range of the range_vector and ones having a null ref.
// The returned pointer is never null.

template <class SC>
typename SC::slices_t::value_type::pointer
get_or_create_ptr(SC &sc, typename SC::slices_t::index_type i) {
    typename SC::slices_t::value_type *p = &(sc.slices.get_or_create(i));
    // If the smart pointer is null, make it point to a new item
    if (! *p)
        p->reset(sc.make());
    return p->get();
}

// Return the coefficient index (the time in terms of coefficient
// subsamples) of the first cofficient of slice "sli" of band
// "obno" in octave "oct"

static inline coef_index_t
coef_time(const oct_coefs_meta &ometa, slice_index_t sli, int oct, int obno) {
    int len = 1 << ometa.cmeta->slice_len_log2;
    return sli * len;
}

// Return the sample index (the time in terms of samples) time of
// coefficient "i" in slice "sli" of band "obno" in octave "oct"

static inline sample_index_t
sample_time(const oct_coefs_meta &ometa, slice_index_t sli, int i, int oct, int obno) {
    coef_index_t sst = coef_time(ometa, sli, oct, obno) + i;
    return shift_left(sst, ometa.step_log2);
}

// Multirate sliced coefficients.  These cover an arbitrary time
// range and the full frequency range (all octaves).
// Template arguments:
//     T analyzer sample data type
//     C coefficient data type
// Note default for template argument C defined in forward declaration.

template <class T, class C>
struct coefs {
    typedef C value_type;
    coefs(const analyzer<T> &anl_):
        cmeta(anl_.cmeta_any.get()),
        octaves(cmeta->n_octaves)
    {
        init();
    }
#if GABORATOR_COEFS_DEEP_COPY
    coefs(const coefs<T, C> &c):
        cmeta(c.cmeta),
        octaves(c.octaves.size())
    {
        init();
        copy_from(c);
    }
    coefs<T, C> &operator=(const coefs<T, C> &c) {
        clear();
        copy_from(c);
        return *this;
    }
#else
    coefs(const coefs<T, C> &c) = delete;
    coefs<T, C> &operator=(const coefs<T, C> &c) = delete;
#endif
    coefs(coefs<T, C> &&c):
        cmeta(c.cmeta),
        octaves(std::move(c.octaves))
    { }
    coefs<T, C> &operator=(coefs<T, C> &&c) {
        clear();
        cmeta = c.cmeta;
        octaves = std::move(c.octaves);
        return *this;
    }
private:
    void init() {
        // Set up shortcut pointer to octave metadata in each octave
        assert(octaves.size() == cmeta->octaves.size());
        for (unsigned int oct = 0; oct < octaves.size(); oct++)
            octaves[oct].ometa = &cmeta->octaves[oct];
    }
    void copy_from(const coefs<T> &c) {
        process([](int b, int64_t t, complex<T> &c0, complex<T> &c1) {
                    c1 = c0;
                },
                INT_MIN, INT_MAX, INT64_MIN, INT64_MAX,
                const_cast<coefs<T, C> &>(c), *this);
    }
public:
    uint64_t estimate_memory_usage() const {
        uint64_t s = 0;
        for (unsigned int oct = 0; oct < octaves.size(); oct++)
            s += octaves[oct].estimate_memory_usage();
        return s;
    }
    void clear() {
        for (unsigned int oct = 0; oct < octaves.size(); oct++)
            octaves[oct].clear();
    }
    // Metadata describing the structure of the coefficients.
    coefs_meta *cmeta;
    std::vector<sliced_coefs<C>> octaves;
};

// Read coefficients i0..i1 of band gbno in msc into dst.

template <class T, class C>
void read(const coefs<T, C> &msc, int gbno,
          coef_index_t i0, coef_index_t i1, C *dst)
{
    int oct;
    unsigned int obno; // Band number within octave
    bool valid = gaborator::bno_split(*msc.cmeta, gbno, oct, obno, true);
    assert(valid);
    row_source<T, C *, C>(msc, oct, obno)(i0, i1, dst);
}

// Write coefficients from src into coefficients i0..i1 of band gbno
// in msc.

template <class T, class C>
void write(coefs<T, C> &msc, int gbno,
           coef_index_t i0, coef_index_t i1, C *src)
{
    int oct;
    unsigned int obno; // Band number within octave
    bool valid = gaborator::bno_split(*msc.cmeta, gbno, oct, obno, true);
    assert(valid);
    row_dest<T, C *, C>(msc, oct, obno)(i0, i1, src);
}

// Add the coefficients in buf to the coefficients i0..i1 of band gbno
// in msc.

template <class T, class C>
void add(coefs<T, C> &msc, int gbno,
         coef_index_t i0, coef_index_t i1, C *buf)
{
    int oct;
    unsigned int obno; // Band number within octave
    bool valid = gaborator::bno_split(*msc.cmeta, gbno, oct, obno, true);
    assert(valid);
    row_add_dest<T, C *, C>(msc, oct, obno)(i0, i1, buf);
}

// Return the base 2 logarithm of the time step (aka downsampling
// factor) of band "gbno".

static inline
unsigned int band_step_log2(const coefs_meta &cmeta, int gbno) {
    assert(gbno >= 0 && gbno < (int) cmeta.bands.size());
    return cmeta.octaves[cmeta.bands[gbno].oct].step_log2;
}


// Convert a signal time t into a coefficient sample
// index.  t must coincide with a coefficient sample time.

static inline
coef_index_t t2i_exact(const coefs_meta &meta, int gbno, sample_index_t t) {
    return shift_right_exact(t, band_step_log2(meta, gbno));
}

// Read a single coefficient sample at signal time t,
// which must coincide with a coefficient sample time

template <class T, class C>
C read1t(const coefs<T, C> &msc, int gbno, sample_index_t t) {
    coef_index_t i = t2i_exact(*msc.cmeta, gbno, t);
    C c;
    read(msc, gbno, i, i + 1, &c);
    return c;
}

// Read a single coefficient sample at signal time t,
// which must coincide with a coefficient sample time

template <class T, class C>
void write1t(coefs<T, C> &msc, int gbno, sample_index_t t, C c) {
    coef_index_t i = t2i_exact(*msc.cmeta, gbno, t);
    write(msc, gbno, i, i + 1, &c);
}

// Perform an fftshift of the range between iterators a and b.
// Not optimized - not for use in inner loops.

template <class I>
void fftshift(I b, I e) {
    size_t len = e - b;
    assert(len % 2 == 0);
    for (size_t i = 0; i < len / 2; i++)
        std::swap(*(b + i), *(b + len / 2 + i));
}

// Evaluate a Gaussian windowed lowpass filter frequency response.
// This is the convolution of a rectangle centered at f=0 and a Gaussian,
// and corresponds to a Gaussian windowed sinc in the time domain.
// The -6 dB cutoff freqency is ff_cutoff (a fractional frequency),
// the standard deviation of the Gaussian is ff_sd, and the frequency
// response is evaluated at ff.  The frequency response is smooth at
// f=0 even if the transition bands overlap.

static inline double
gaussian_windowed_lowpass_1(double ff_cutoff, double ff_sd, double ff) {
    return
        // A rectangle is the sum of a rising step and a later falling
        // step, or the difference between a rising step and a later
        // rising step.  By linearity, a Gaussian filtered rectangle
        // is the difference between two Gaussian filtered rising
        // steps.
        gaussian_edge(ff_sd, -ff + ff_cutoff) -
        gaussian_edge(ff_sd, -ff - ff_cutoff);
}

// Fill a sequence with a frequency-domain lowpass filter as above.
// The returned filter covers the full frequency range from 0 to fs
// (with negative frequencies at the end, the usual convention for FFT
// spectra).
//
// When center=true, construct a time-domain window instead,
// passing the center of the time-domain signal.
//
// The result is stored between iterators b and e, which must have a
// real value_type.

template <class I>
void gaussian_windowed_lowpass(double ff_cutoff, double ff_sd,
                                      I b, I e, bool center = false)
{
    size_t len = e - b;
    double inv_len = 1.0 / len;
    for (I it = b; it != e; ++it) {
        size_t i = it - b;
        double thisff;
        if (center)
            // Symmetric around center
            thisff = std::abs(i - (len * 0.5)) * inv_len;
        else
            // Symmetric around zero
            thisff = (i > len / 2 ? len - i : i) * inv_len;
        *it = gaussian_windowed_lowpass_1(ff_cutoff, ff_sd, thisff);
    }
}

// Per-band data that is never shared between octaves

struct band_info {
    int oct; // Octave number
    int obno; // Band number within octave
};

// A set of octaves having identical parameters form a "zone",
// and their shared parameters are stored in a "struct zone".

template <class T>
struct zone: public refcounted {
    zone() { }
    ~zone() { }
    // Zone number, typically 0..3 when the number of bands per
    // octave is an integer, or equal to the octave number when not.
    int zno;
    int max_step_log2;
    // Band parameters by decreasing frequency; DC band is the last
    // element if present
    std::vector<ref<band_params<T>>> bandparams;
    std::vector<ref<band_params<T>>> mock_bandparams;
    struct {
        // The width of the widest filter in the time domain, in
        // octave subsamples.
        int oct_support;

        // The amount of FFT padding needed, including alignment
        int fat_size;
    } dir[2];
};

template <class T>
struct octave {
    zone<T> *z;
    unsigned int n_bands; // Number of bands in this octave
    unsigned int n_bands_above; // Total number of bands in higher octaves
};

// Helper function for pushing parameters onto the vectors in struct zone

template <class T>
void push(std::vector<ref<band_params<T>>> &v, band_params<T> *p) {
    v.push_back(ref<band_params<T>>(p));
}

// Phase conventions: coef_phase::global means the phase of a
// coefficient at time tc is relative to e^(i tau f t), and
// coef_phase::local means it is relative to e^(i tau f (t - tc)).

enum class coef_phase { global, local };

// Helper macro for defining "operator <" on objects

#define GABORATOR_COMPARE_LESS(member) do { \
        if (member < b.member) \
            return true; \
        if (b.member < member) \
            return false; \
        } while(0)

// A frequency scale, such as a logarithmic or linear scale.

struct fq_scale: public refcounted {
    virtual ~fq_scale() { }

    virtual fq_scale *clone() const = 0;

    // Provide an operator< so that we can create a set or map of
    // frequency scales, including ones of different subclasses.
    bool operator<(const fq_scale &b) const {
        const std::type_info &ta(typeid(*this));
        const std::type_info &tb(typeid(b));
        if (ta.before(tb))
            return true;
        if (tb.before(ta))
            return false;
        return less_than(b);
    }

    // Also provide an operator==.
    bool operator==(const fq_scale &b) const {
        return !((*this < b) || (b < *this));
    }

    // Compare two frequency scales of the same derived type.
    virtual bool less_than(const fq_scale &b) const = 0;

    // Return the spacing in frequency between adjacent bands in the
    // vicinity of frequency ff.  This should be f(ff_bandpass_band(ff))
    // where f() is the derivative of bandpass_band_ff(), though in the
    // case of log_fq_scale_v1, it is slightly different in the interest
    // of bug-for-bug compatibilty.
    virtual double band_spacing_at(double ff) const = 0;

    // Return true iff the scale features repeating octaves
    // that can share coefficients.
    virtual bool octaves_repeat() const { return false; }

    // Return true iff the scale reaches a frequency of zero
    // (like linear scales do and log scales don't).
    virtual bool reaches_dc() const = 0;

    // If the scale has pathological parameters that may cause the
    // reconstruction filters to be less smooth than usual and require
    // a larger-than-usual equalization support multiplier, return it
    // here.
    virtual double eq_support_multiplier() const { return 1.0; }

    // Get the center frequency of bandpass band "gbno", which
    // need not be a valid bandpass band number; out-of-range
    // arguments will return extrapolated frequencies.
    virtual double bandpass_band_ff(double gbno) const = 0;

    // Get the band number of the bandpass band corresponding
    // to the fractional frequency "ff", as a floating point
    // number.  This is the inverse of bandpass_band_ff().
    virtual double ff_bandpass_band(double ff) const = 0;

    // For scales that have a user-specified reference frequency,
    // return the band number of the band having that frequency.
    // For other scales, return the band number of some fixed
    // band appropriate to use as a reference point, for example
    // a band at 0 Hz.
    virtual int band_ref() const { abort(); }

    virtual int n_bandpass_bands() const = 0;
    virtual bool has_lowpass_band() const = 0;
    virtual bool multirate() const = 0;
};

// Logarithmic frequency scale

struct log_fq_scale: public fq_scale {
    log_fq_scale(double bands_per_octave_, double ff_min_, double ff_ref_ = 0.5):
        bands_per_octave(bands_per_octave_),
        ff_min(ff_min_),
        ff_ref(ff_ref_)
    {
        // Sanity check
        assert(ff_min < 0.5);

        // The tuning adjustment, as a log2ff.  This is a number
        // between 0 and band_spacing_log2, indicating how much
        // each band should be tuned down compared to the untuned
        // case where one band falls on the Nyquist frequency
        // exactly.
        double tune_down_log2ff =
            sane_fmod(-1 - log2(ff_ref), band_spacing_log2());

        // The frequency of the highest-frequency band, as a log2ff.
        double top_band_log2ff = -1 - tune_down_log2ff;

        // Calculate the total number of bandpass bands needed so that
        // the lowest one has a frequency <= params.ff_min.
        n_bandpass_bands_total =
            (unsigned int)ceil((top_band_log2ff - log2(ff_min)) /
                               band_spacing_log2()) + 1;

        ffref_gbno = (int) rint((top_band_log2ff - log2(ff_ref)) /
                                band_spacing_log2());

        // Establish affine transforms for converting between
        // log-frequencies (log2(ff)) and bandpass band numbers.
        // Derivation:
        //ff = exp2(tuning_log2ff - 1 - (gbno + 1) * band_spacing_log2)
        //log2(ff) = tuning_log2ff - 1 - (gbno + 1) * band_spacing_log2
        //tuning_log2ff - 1 - (gbno + 1) * band_spacing_log2 = log2(ff)
        //-(gbno + 1) * band_spacing_log2 = log2(ff) - tuning_log2ff + 1
        //-(gbno + 1) * band_spacing_log2 = log2(ff) - tuning_log2ff + 1
        //-(gbno + 1) = (log2(ff) - tuning_log2ff + 1) / band_spacing_log2
        //-gbno - 1 = (log2(ff) - tuning_log2ff + 1) / band_spacing_log2
        //-gbno = ((log2(ff) - tuning_log2ff + 1) / band_spacing_log2) + 1
        //gbno = -(((log2(ff) - tuning_log2ff + 1) / band_spacing_log2) + 1)
        //gbno = a log2(ff) + b,
        //       where a = -1 / band_spacing_log2 = -params.bands_per_octave
        //       and b = -a * tuning_log2ff + a - 1
        double a = -bands_per_octave;
        double b = a * tune_down_log2ff + a;

        // Set members
        log2ff_bandpass_band = affine_transform(a, b);
        bandpass_band_log2ff = log2ff_bandpass_band.inverse();
    }
    log_fq_scale *clone() const {
        return new log_fq_scale(*this);
    }
    bool less_than(const fq_scale &b_base) const {
        const log_fq_scale &b(dynamic_cast<const log_fq_scale &>(b_base));
        GABORATOR_COMPARE_LESS(bands_per_octave);
        GABORATOR_COMPARE_LESS(ff_min);
        GABORATOR_COMPARE_LESS(ff_ref);
        return false;
    }
    double band_spacing_at(double ff) const {
        return ff * log(2) / bands_per_octave;
    }
    bool octaves_repeat() const {
        return integerp(bands_per_octave) &&
            bands_per_octave >= 6;
    }
    bool reaches_dc() const { return false; }
    double bandpass_band_ff(double gbno) const {
        return exp2(bandpass_band_log2ff(gbno));
    }
    double ff_bandpass_band(double ff) const {
        return log2ff_bandpass_band(log2(ff));
    }
    double eq_support_multiplier() const {
        if (bands_per_octave <= 4)
            return 2.5;
        // Use the default, which will be greater than 1.0
        return 1.0;
    }
protected:
    // The frequency decreases by a factor of band_spacing from
    // one bandpass band to the next.
    double band_spacing_log2() const {
        return 1.0 / bands_per_octave;
    }
    double band_spacing() const {
        return exp2(band_spacing_log2());
    }
public:
    int band_ref() const {
        return ffref_gbno;
    }
    int n_bandpass_bands() const {
        return n_bandpass_bands_total;
    }
    bool has_lowpass_band() const {
        return true;
    }
    bool multirate() const {
        return true;
    }
    double bands_per_octave;
    double ff_min;
    double ff_ref;

    // Derived
    affine_transform log2ff_bandpass_band;
    affine_transform bandpass_band_log2ff;
    int n_bandpass_bands_total;
    int ffref_gbno;
};

// Logarithmic frequency scale bug-for-bug compatible with
// Gaborator version 1

struct log_fq_scale_v1: public log_fq_scale {
    log_fq_scale_v1(double bands_per_octave_, double ff_min_, double ff_ref_):
        log_fq_scale(bands_per_octave_, ff_min_, ff_ref_) {
    }
    double band_spacing_at(double ff) const {
        return ff * (band_spacing() - 1);
    }
};

// Linear frequency scale

struct lin_fq_scale: public fq_scale {
    lin_fq_scale(double size_):
        size(size_)
    {
    }
    lin_fq_scale *clone() const {
        return new lin_fq_scale(*this);
    }
    bool less_than(const fq_scale &b_base) const {
        const lin_fq_scale &b(dynamic_cast<const lin_fq_scale &>(b_base));
        GABORATOR_COMPARE_LESS(size);
        return false;
    }
    double band_spacing_at(double) const {
        // Does not depend on ff argument
        return 1.0 / size;
    }
    bool reaches_dc() const { return true; }
    double bandpass_band_ff(double gbno) const {
        return (n_bandpass_bands() - 1 - gbno) / size;
    }
    double ff_bandpass_band(double ff) const {
        return n_bandpass_bands() - 1 - (ff * size);
    }
    int band_ref() const {
        // Use the bandpass band at DC as the reference band
        return n_bandpass_bands() - 1;
    }
    int n_bandpass_bands() const {
        // Includes Nyquist band in case of even integer size only
        return floor(size * 0.5 + 1.0);
    }
    bool has_lowpass_band() const {
        return false;
    }
    bool multirate() const {
        return false;
    }

    double size;
};

// Mel frequency scale

// Unlike the other scales, this is not sample rate agnostic, as the
// mel scale is inherently defined in terms of absolute frequencies
// (Hz).  Therefore, we need to pass in the sample rate.

// XXX This could really use a band numbering that increases with
// frequency.

struct mel_fq_scale: public fq_scale {
    mel_fq_scale(double bands_per_mel_, double fs_):
        bands_per_mel(bands_per_mel_),
        fs(fs_)
    {
        // We center one band (the last, given the reversed numbering) on
        // ff=0 to keep converting between bands and mels simple.  The first
        // band will then be at ff=0.5 or slightly below.
        n_bands = floor(hz_mel(fs_ * 0.5) * bands_per_mel) + 1;
    }

    mel_fq_scale *clone() const {
        return new mel_fq_scale(*this);
    }

    // Convert mels to bands
    double mel_bandpass_band(double mel) const {
        return (n_bands - 1) - mel * bands_per_mel;
    }

    // Convert bands to mels
    double bandpass_band_mel(double band) const {
        return ((n_bands - 1) - band) / bands_per_mel;
    }

    double bandpass_band_ff(double band) const {
        double mel = bandpass_band_mel(band);
        double f = mel_hz(mel);
        return f / fs;
    }

    double ff_bandpass_band(double ff) const {
        double mel = hz_mel(ff * fs);
        return mel_bandpass_band(mel);
    }

    double band_spacing_at(double ff) const {
        return 7 * log(10) *
            pow(10, log10(ff * fs / 700 + 1) + 2) /
            (2595 * bands_per_mel * fs);
    }

    bool less_than(const fq_scale &b_base) const {
        const mel_fq_scale &b(dynamic_cast<const mel_fq_scale &>(b_base));
        GABORATOR_COMPARE_LESS(bands_per_mel);
        GABORATOR_COMPARE_LESS(fs);
        return false;
    }
    bool reaches_dc() const { return true; }

    int band_ref() const {
        // Use the bandpass band at DC as the reference band
        return n_bands - 1;
    }

    int n_bandpass_bands() const {
        return n_bands;
    }

    bool has_lowpass_band() const {
        return false;
    }
    bool multirate() const {
        return true;
    }

    double bands_per_mel;
    double fs;
    int n_bands;
};

// A set of spectrum analysis parameters

struct parameters {
    // Version 2
    parameters(const fq_scale &scale_,
               double overlap_ = overlap_default,
               double max_error_ = max_error_default):
        scale(scale_.clone()),
        overlap(overlap_),
        max_error(max_error_),
        coef_scale(1.0),
        synthesis(true),
        multirate(scale->multirate()),
        eq_dir(eq_dir_default)
    {
        phase = coef_phase::local;
        lowpass_version = 2;
    }

    // Version 1 backwards compatibility
    parameters(double bands_per_octave_,
               double ff_min_,
               double ff_ref_ = 1.0,
               double overlap_ = overlap_default,
               double max_error_ = max_error_default):
        scale(new log_fq_scale_v1(bands_per_octave_, ff_min_, ff_ref_)),
        overlap(overlap_),
        max_error(max_error_),
        coef_scale(1.0),
        synthesis(true),
        multirate(scale->multirate()),
        eq_dir(eq_dir_default)
    {
        phase = coef_phase::global;
        lowpass_version = 1;
    }

    // Default constructor
    parameters() {
    }

    // Provide an operator< so that we can create a set or map of parameters
    bool operator<(const parameters &b) const {
        // First compare the frequency scales; this is a special
        // case because of indirection.
        if (*scale.get() < *b.scale.get())
            return true;
        if (*b.scale.get() < *scale.get())
            return false;
        // Compare the rest of the fields in a regular fashion
        GABORATOR_COMPARE_LESS(overlap);
        GABORATOR_COMPARE_LESS(max_error);
        GABORATOR_COMPARE_LESS(phase);
        GABORATOR_COMPARE_LESS(lowpass_version);
        GABORATOR_COMPARE_LESS(coef_scale);
        GABORATOR_COMPARE_LESS(synthesis);
        GABORATOR_COMPARE_LESS(multirate);
#undef GABORATOR_COMPARE_LESS
        // Equal
        return false;
    }
    bool operator==(const parameters &b) const {
        return !((*this < b) || (b < *this));
    }

    template <class T> friend struct analyzer;
    ref<fq_scale> scale;
    double overlap;
    double max_error;
    coef_phase phase;
    int lowpass_version;
    double coef_scale;
    bool synthesis; // Synthesis is supported
    bool multirate;
    int eq_dir;
};

// Like std::fill, but returns the end iterator

template <class I, class T>
I fill(I b, I e, T v) {
    std::fill(b, e, v);
    return e;
}

// Multiply a vector by a scalar, in-place.
// Used only at the setup stage, so performance is not critical.

template <class V, class S>
void scale_vector(V &v, S s) {
    for (auto &e: v)
        e *= s;
}

// Zero-padding source wrapper.  This returns data from the underlying
// source within the interval src_i0 to src_i1, and zero elsewhere.

template <class S, class OI>
struct zeropad_source {
    typedef typename std::iterator_traits<OI>::value_type T;
    zeropad_source(const S &source_, int64_t src_i0_, int64_t src_i1_):
        source(source_), src_i0(src_i0_), src_i1(src_i1_)
    { }
    OI operator()(int64_t i0, int64_t i1, OI output) const {
        int64_t overlap_begin = std::max(i0, src_i0);
        int64_t overlap_end = std::min(i1, src_i1);
        if (overlap_end <= overlap_begin) {
            // No overlap
            output = gaborator::fill(output, output + (i1 - i0), (T) 0);
        } else {
            // Some overlap
            if (overlap_begin != i0) {
                output = gaborator::fill(output, output + (overlap_begin - i0), (T) 0);
            }
            output = source(overlap_begin, overlap_end, output);
            if (overlap_end != i1) {
                output = gaborator::fill(output, output + (i1 - overlap_end), (T) 0);
            }
        }
        return output;
    }
    const S &source;
    int64_t src_i0, src_i1;
};

template <class T>
struct pointer_source {
    pointer_source(const T *p_, int64_t buf_i0_, int64_t buf_i1_):
        p(p_), buf_i0(buf_i0_), buf_i1(buf_i1_) { }
    T *operator()(int64_t i0, int64_t i1, T *output) const {
        assert(i1 >= i0);
        assert(i0 >= buf_i0);
        assert(i1 <= buf_i1);
        return std::copy(p + (i0 - buf_i0), p + (i1 - buf_i0), output);
    }
    const T *p;
    int64_t buf_i0, buf_i1;
};

// Fill the buffer at dst, of length dstlen, with data from src where
// available, otherwise with zeroes.  The data in src covers dst indices
// from i0 (inclusive) to i1 (exclusive).

template <class T>
void copy_overlapping_zerofill(T *dst, size_t dstlen, const T *src,
                               int64_t i0, int64_t i1)
{
    pointer_source<T> ps(src, i0, i1);
    zeropad_source<pointer_source<T>, T *> zs(ps, i0, i1);
    zs(0, dstlen, dst);
}

// Given a set of FFT coefficients "coefs" of a real sequence, where
// only positive-frequency coefficients (including DC and Nyquist) are
// valid, return the coefficient for an arbitrary frequency index "i"
// which may correspond to a negative frequency, or even an alias
// outside the range (0..fftsize-1).

template <class T>
complex<T> get_real_spectrum_coef(const complex<T> *coefs,
                                  int i, unsigned int fftsize)
{
    i &= fftsize - 1;
    // Note that this is >, not >=, becase fs/2 is considered nonnegative
    bool neg_fq = (i > (int)(fftsize >> 1));
    if (neg_fq) {
        i = fftsize - i;
    }
    complex<T> c = coefs[i];
    if (neg_fq) {
        c = conj(c);
    }
    return c;
}

// A set of buffers of various sizes used for temporary vectors during
// analysis.  These are allocated as a single block to reduce the
// number of dynamic memory allocations.

template <class T>
struct buffers {
    static const size_t maxbufs = 10;
    typedef complex<T> C;
    buffers(unsigned int fftsize_max,
            unsigned int sftsize_max):
        n(0)
    {
        offset[0] = 0;
        // Define the size of each buffer
        def(fftsize_max * sizeof(C)); // 0
        def(fftsize_max * sizeof(C)); // 1
        def(sftsize_max * sizeof(C)); // 2
        def(sftsize_max * sizeof(C)); // 3
        def(sftsize_max * sizeof(C)); // 4
        def(fftsize_max * sizeof(T)); // 5
        assert(n <= maxbufs);
        data = ::operator new(offset[n]);
    }
    ~buffers() {
        ::operator delete(data);
    }
    buffers(const buffers &) = delete;
    buffers &operator=(const buffers &) = delete;

    void def(size_t size) {
        size_t o = offset[n++];
        offset[n] = o + size;
    }
    // A single buffer of element type E
    template <class E>
    struct buffer {
        typedef E *iterator;
        buffer(void *b_, void *e_):
            b((E *)b_), e((E *)e_)
        { }
        iterator begin() const { return b; }
        iterator end() const { return e; }
        E *data() { return b; }
        const E *data() const { return b; }
        E &operator[](size_t i) { return b[i]; }
        const E &operator[](size_t i) const { return b[i]; }
        size_t size() const { return e - b; }
    private:
        E *b;
        E *e;
    };
    // Get buffer number "i" as a vector-like object with element type "E"
    // and a length of "len" elements.
    template <class E>
    buffer<E> get(size_t i, size_t len) {
        len *= sizeof(E);
        size_t o = offset[i];
        assert(len <= offset[i + 1] - o);
        return buffer<E>((char *)data + o, (char *)data + o + len);
    }
private:
    void *data;
    size_t n;
    size_t offset[maxbufs + 1];
};

// Get the bounds of the range of existing coefficients for a
// given band, in units of coefficient samples.

template <class T, class C>
void get_band_coef_bounds(const coefs<T, C> &msc, int oct, unsigned int obno,
                          coef_index_t &ci0_ret, coef_index_t &ci1_ret)
{
    const sliced_coefs<C> &sc = msc.octaves[oct];
    const typename sliced_coefs<C>::slices_t &slices = sc.slices;
    if (slices.empty()) {
        // Don't try to convert int64t_min/max slices to coef time
        ci0_ret = 0;
        ci1_ret = 0;
        return;
    }
    // Convert from slices to coefficient samples
    ci0_ret = coef_time(*sc.ometa, slices.begin_index(), oct, obno);
    ci1_ret = coef_time(*sc.ometa, slices.end_index(), oct, obno);
}

template <class T, class C>
void get_band_coef_bounds(const coefs<T, C> &msc, int gbno,
                          coef_index_t &ci0_ret, coef_index_t &ci1_ret)
{
    int oct;
    unsigned int obno; // Band number within octave
    bool r = gaborator::bno_split(*msc.cmeta, gbno, oct, obno, true);
    assert(r);
    get_band_coef_bounds(msc, oct, obno, ci0_ret, ci1_ret);
}

// Evaluate the frequency-domain analysis filter kernel of band "bp"
// at frequency "ff"

template <class T>
double eval_kernel(parameters *, band_params<T> *bp, double ff) {
    if (bp->dc) {
        return gaussian_windowed_lowpass_1(bp->ff, bp->ffsd, ff);
    } else {
        return norm_gaussian(bp->ffsd, ff - bp->ff);
    }
}

// Evaluate the frequency-domain synthesis filter kernel of band "bp"
// at frequency "ff"

template <class T>
double eval_dual_kernel(parameters *params, band_params<T> *bp, double ff) {
    double gain = 1.0;
    if (params->lowpass_version == 2) {
        if (bp->dc) {
            // Adjust the gain of the reconstruction lowpass filter to
            // make the overall gain similar to the bandpass region.
            // This does not give the right gain with bandwidth formula
            // v1, but it's unlikely that anyone wants that with lowpass
            // version v2.
            double avg_bandpass_gain = params->overlap * sqrt(M_PI);
            gain = avg_bandpass_gain * 0.5;
        }
    }
    return eval_kernel(params, bp, ff) * gain;
}

// A downsampling (decimation) / upsampling (interpolation)
// filter for audio multirate processing.

struct ds_filter {
    ds_filter(double f0_, double max_error):
        f0(f0_)
    {
        double f1 = 0.5;
        assert(f0 < f1);
        // The cutoff frequency is at the center of the transition band
        ff = (f0 + f1) * 0.5;
        double support = (f1 - f0) * 0.5;
        ff_sd = gaussian_support_inv(support, max_error);
        double time_sd = sd_f2t(ff_sd);
        // Calculate the time-domain support of the downsampling
        // lowpass filter for use in analyze_sliced().  Since the
        // filter is designed at the lower sample rate,
        // ds_time_support is in the unit of lower octave samples.
        time_support = gaussian_support(time_sd, max_error * 0.4);
    }
    // Width of the downsampling filter passband in terms of the
    // downsampled sample rate (between 0.25 and 0.5)
    double f0;
    double ff; // -6 dB transition frequency
    double ff_sd; // Standard deviation in frequency domain
    // Time-domain kernel support, each side, in terms of the lower
    // sample rate.
    double time_support;
};

// Downsampling parameters.  These have some similarity to band
// parameters, but only some.  For example, these may use a real
// rather than complex FFT for the "short FFT".

template <class T>
struct ds_plan {
    ds_plan(const ds_filter *filter, resource_pool<T> *rpool,
            unsigned int fftsize, int d)
    {
        // Downsampling is always by a factor of two.
        // dsplan.sftsize is the size of the FFT used to go back to
        // the time domain after discarding the top half of the
        // spectrum.
        sftsize = fftsize >> 1;
        dir[d].kernel.resize(sftsize);

        // In the frequency domain, the downsampling filter is the
        // convolution of a rectangle and a Gaussian.  A piecewise
        // function composed from two half-gaussians joined by a
        // horizontal y=1 segment is not quite smooth enough.  Put
        // the passband in the middle.  The upsampling filter is
        // identical except for amplitude scaling.
        double scale = d ? 1.0 / sftsize : 1.0 / fftsize;
        for (int i = 0; i < (int) sftsize; i++)
            dir[d].kernel[i] =
                scale *
                gaussian_windowed_lowpass_1
                    (filter->ff, filter->ff_sd,
                     ((double) i / sftsize) - 0.5);

        rsft = rpool->rft.get(sftsize);
    }
    typedef complex<T> C;
    unsigned int sftsize;
    struct {
        std::vector<T> kernel; // Frequency-domain filter kernel
    } dir[2];
    rfft<C *> *rsft;
};

template <class T>
struct plan {
    typedef complex<T> C;

    plan(resource_pool<T> *rpool, const ds_filter *ds, bool dir_,
         unsigned int fftsize_):
        dir(dir_),
        fftsize(fftsize_),
        sftsize_max(0),
        dsplan(ds, rpool, fftsize, dir)
    {
        fftsize_log2 = whichp2(fftsize);

        inv_fftsize_double = 1.0 / fftsize;
        inv_fftsize_t = (T) inv_fftsize_double;

        rft = rpool->rft.get(fftsize);
    }

    int dir; // 0 = analysis, 1 = synthesis

    unsigned int fftsize_log2; // log2(fftsize)
    unsigned int fftsize; // The size of the main FFT, a power of two.

    double inv_fftsize_double; // 1.0 / fftsize
    T inv_fftsize_t; // 1.0f / fftsize (if using floats)

    // The size of the largest band FFT, a power of two
    unsigned int sftsize_max;

    // Per-plan downsampling parameters
    ds_plan<T> dsplan;

    // Fourier transform object for transforming a full slice
    rfft<C *> *rft;
};

// No-op function object, to be used for any unused callbacks of
// analyze_sliced().

struct nop {
    template <class... T>
    void operator()(T...) {
    }
};

// Analyze a signal segment consisting of any number of samples.
//
// anl is the analyzer; this can be either a gaborator::analyzer
//   to perform a full analysis creating spectrogram coefficients,
//   or potentially a stripped-down analyzer for creating a multirate
//   representation only.
// buf is a set of buffers
// oct is the octave; this is 0 except in recursive calls
// real_signal points to the first sample
// t0 is the sample time of the first sample
// t1 is the sample time of the sample after the last sample
// included_ds_support indicates how many samples at each end
//   of real_signal correspond to the pre- and post-ringing of
//   a previously applied decimation filter rather than the
//   actual duration of the undecimated signal, to avoid
//   needless cumulative expansion of the signal as it passes
//   through multiple decimation steps.
// spectrum_f is a function to call with the spectrum of each
//   signal slice of each octave.

template <class A, class T, class SPECTRUM_F, class DS_F>
void
analyze_sliced(const A &anl,
               buffers<T> &bufs, int oct, const T *real_signal,
               sample_index_t t0, sample_index_t t1,
               double included_ds_support,
               SPECTRUM_F spectrum_f,
               DS_F ds_f)
{
    typedef complex<T> C;
    assert(t1 >= t0);
    int fat_size = anl.fat_size(oct);

    int pno = choose_plan(anl.dir[0].plans, t1 - t0, fat_size);
    auto &plan(anl.dir[0].plans[pno]);

    int filet_size = (int) plan.fftsize - 2 * fat_size;

    // The sample time of the first input sample in this slice.
    // This will be preceded by fat and any alignment padding.
    sample_index_t slice_t0_noalign = t0;

    // Even though we don't align the FFTs to full filet-size
    // slices in this code path, we still need to align them to
    // coefficient samples so that we don't have to do expensive
    // sub-sample time shifts.  Specifically, we need to align
    // them to the largest coefficient time step of the octave.
    // slice_t0 is the sample time of the first sample in the
    // filet (not the FFT as a whole).
    sample_index_t slice_t0 = t0 & ~(anl.align(oct) - 1);

    // Find the number of slices we need to divide the signal into.
    int64_t n_slices =
        ((t1 - slice_t0) + (filet_size - 1)) / filet_size;

    // The one-sided downsampling filter support rounded up to an
    // integer, not trimmed by included_ds_support.
    int ds_full_support = (int) ceil(anl.ds.time_support);

    // The affected sample range in the downsampled signal, for
    // the entire call (not just a single slice).
    int ds_trimmed_support =
        (int) ceil(anl.ds.time_support - included_ds_support);
    sample_index_t dst0a = (t0 >> 1) - ds_trimmed_support;
    sample_index_t dst1a = (t1 >> 1) + 1 + ds_trimmed_support;

    // Buffer for the downsampled signal.  Since the size depends
    // on the total amount of signal analyzed in this call (being
    // about half of it), it can't be preallocated, but has to be
    // dynamically allocated in each call.  The first element
    // corresponds to sample time dst0a at the lower sample rate.
    pod_vector<T> dsbuf(dst1a - dst0a);

    // dsbuf will be added to, not assigned to, so we need to
    // initialize it to zero.
    std::fill(dsbuf.begin(), dsbuf.end(), (T) 0);

    auto slice(bufs.template get<T>(5, plan.fftsize));
    // Clear the fat on both ends (once)
    std::fill(slice.data(), slice.data() + fat_size, (T) 0);
    std::fill(slice.data() + slice.size() - fat_size,
              slice.data() + slice.size(), (T) 0);

    // For each slice.  Note that slice_i counts from 0, not from
    // the slice index of the first slice.
    for (int64_t slice_i = 0; slice_i < n_slices; slice_i++) {
        if (slice_t0 >= t1)
            break;
        sample_index_t slice_t1 = std::min(slice_t0 + filet_size, t1);
        // Copy into filet part of aligned buffer, possibly zero padding
        // if the remaining signal is shorter than a full slice.
        copy_overlapping_zerofill(slice.data() + fat_size,
                                  filet_size,
                                  real_signal,
                                  t0 - slice_t0,
                                  t1 - slice_t0);
        // Analyze the slice
        auto spectrum(bufs.template get<C>(1, plan.fftsize));
        plan.rft->transform(slice.data(), spectrum.data());

        // Optionally process the spectrum
        // XXX reduce redundant args such as pno/plan
        spectrum_f(oct, pno, plan, spectrum.data(), slice_t0 - fat_size, t0, t1);

        // Downsample
        if (oct + 1 < anl.get_n_octaves()) {
            auto sdata(bufs.template get<C>(2, plan.dsplan.sftsize));
            // This is using a larger buffer than we actually need
            auto ddata(bufs.template get<C>(0, plan.dsplan.sftsize));
            assert(ddata.size() >= plan.dsplan.sftsize);
            // Extract the low-frequency part of "spectrum" into "sdata"
            // and multiply it by the lowpass filter frequency response.
            // This means both positive and negative low frequencies.
            size_t half_size = plan.dsplan.sftsize >> 1;
            assert(plan.fftsize - half_size == 3 * half_size);

            // Find the affected sample range in the downsampled
            // signal, for this slice only.  Analogous to the ii0,
            // ii1 calculated earlier for affected coefficients.
            // Note that we must use ds_full_support rather than
            // ds_trimmed_support here, because included_ds_support
            // does not apply to inter-slice boundaries.
            int64_t ii0 = (slice_t0_noalign >> 1) - ds_full_support;
            int64_t ii1 = (slice_t1 >> 1) + 1 + ds_full_support;

            // The origin of the IFFT output array in the downsampled
            // sample numbering
            int64_t ddata_idx = shift_right_exact(slice_t0 - fat_size, 1);

            // Make sure the range doesn't overflow the FFT output
            set_max(ii0, ddata_idx);
            set_min(ii1, ddata_idx + (int64_t) plan.dsplan.sftsize);
            // Make sure the range doesn't overflow dsbuf
            set_max(ii0, dst0a);
            set_min(ii1, dst0a + (int64_t) dsbuf.size());

            // Positive frequencies
            elementwise_product(sdata.data(), spectrum.data(),
                                plan.dsplan.dir[0].kernel.data() + half_size,
                                half_size);
            // Nyquist
            sdata[half_size] = 0;
            // Use the same buffer as the complex FFT, but as real
            // rather than complex values.
            T *real_ddata = reinterpret_cast<T *>(ddata.data());
            plan.dsplan.rsft->itransform(sdata.data(), real_ddata);
            // Accumulate the contribution of this slice to the
            // downsampled data.
            for (int64_t ii = ii0; ii < ii1; ii++)
                dsbuf[ii - dst0a] += real_ddata[ii - ddata_idx];
        }

        // Next slice
        slice_t0 = slice_t1;
        // There is no alignment padding in slices other than
        // the first, so slice_t0_noalign is the same as slice_t0.
        slice_t0_noalign = slice_t0;
    }

    if (oct + 1 < anl.get_n_octaves()) {
        // Optionally save downsampled data
        ds_f(oct + 1, dsbuf.data(), dst0a, dst1a);
        // Recurse
        analyze_sliced(anl, bufs, oct + 1, dsbuf.data(),
                       dst0a, dst1a, anl.ds.time_support / 2,
                       spectrum_f, ds_f);
    }
}


// Choose a plan among "plans" for analyzing a signal block of
// "size" samples in a zone requiring "fat_size" samples of padding
// on each side.

template <class PLAN>
int choose_plan(const std::vector<PLAN> &plans, int64_t size,
                unsigned int fat_size)
{
    unsigned int i = 0;
    // Find the smallest possible plan, processing at least one
    // sample per slice
    while (i < plans.size() - 1 &&
           plans[i].fftsize < (1 + 2 * fat_size))
        i++;
    // If that plan does not suffice to process the entire signal
    // block, use a larger one, but not larger than needed given
    // the size of the block, and within reason.
    int n_big = 0;
    while (i < plans.size() - 1 &&
           n_big < GABORATOR_N_BIG_PLANS &&
           plans[i].fftsize < (size + 2 * fat_size)) {
        i++;
        n_big++;
    }
    return i;
}

template <class T>
struct analyzer: public refcounted {
    typedef T sample_type;
    typedef complex<T> C;

    analyzer(const parameters &params_,
             resource_pool<T> *rpool_ = 0):
        params(params_),
        rpool(rpool_ ? rpool_ : &my_rpool),
        max_step_log2(0),
        fftsize_max(0),
        sftsize_max(0),
        // Precalculate the parameters of the downsampling filter.
        // These are the same for all plans, and need to be
        // calculated before creating the plans; in particular, we
        // need to know the support before we can create the
        // plans, because in low-bpo cases, it can determine the
        // minimum amount of fat needed.  The filter kernel is
        // specific to the plan as it depends on the FFT size,
        // and will be calculated later.

        // When operating at a high Q, the we will need to use
        // large FFTs in any case, and it makes sense to use a
        // narrow transition band because we can get that
        // essentially for free, and the passband will be
        // correspondingly wider, which will allow processing more
        // bands at the lower sample rate.  Conversely, at low
        // Q, we should use a wide transition band so that the
        // FFTs can be kept short.

        // The filter is defined in terms of the lower
        // (downsampled) sample rate.

        // The goal is to use the steepest downsampling filter we
        // can without forcing us to use a longer FFT than we
        // would otherwise need, which means keeping its impulse
        // response shorter than, or at most as long as, the
        // longest impulse of any other filter.  That longest
        // impulse response belongs to the lowest-frequency
        // bandpass in the octave, but that in turn depends on the
        // octave break point which depends on the downsampling
        // filter steepness, so there is a circular dependency.
        // Resolve this conservatively, by assuming the octave
        // break happens close to the earliest possible point of
        // ff=0.5 (in terms of the lower sample rate), which means
        // the bandpass filter impulse response can be as short as
        // that of a filter at ff=0.5.

        // Make the transition band the same width as the width
        // (two-sided support) of a band at ff=0.5, but don't let
        // the low edge go below 0.25 to make sure we have a
        // reasonable amount of passband left.
        ds(std::max(0.5 - 2 * gaussian_support(ff_sd(0.5), params.max_error),
                    0.25),
           params.max_error)
    {
        n_bandpass_bands_total = params.scale->n_bandpass_bands();
        n_bands_total = n_bandpass_bands_total + params.scale->has_lowpass_band();

        // Determine the octave structure, packing each band into the
        // lowest octave possible so that it can be processed at the
        // lowest possible sample rate.
        bands.resize(n_bands_total);
        int gbno;
        int oct = 0;
        octaves.resize(oct + 1);
        int obno = 0;
        for (gbno = bandpass_bands_begin(); gbno < bandpass_bands_end(); gbno++) {
            double ff = bandpass_band_ff(gbno);
            double ffsd = ff_sd(ff);
            double ff_support = gaussian_support(ffsd, params.max_error * 0.5);
            // If multirate processing is enabled and the bandpass
            // support falls within the downsampling filter passband
            // of the next octave, we can switch octaves.
            while (params.multirate &&
                   ff + ff_support <= ldexp(ds.f0, -(oct + 1)))
            {
                oct++;
                octaves.resize(oct + 1);
                octaves[oct].n_bands_above = gbno;
                obno = 0;
            }
            // Add the band to the current octave
            bands[gbno].oct = oct;
            bands[gbno].obno = obno;
            octaves[oct].n_bands++;
            obno++;
        }

        if (params.scale->has_lowpass_band()) {
            // Put the lowpass band in the same octave as the last
            // bandpass band
            assert(gbno == band_lowpass());
            bands[gbno].oct = oct;
            bands[gbno].obno = obno;
            octaves[oct].n_bands++;
        }

        n_octaves = oct + 1;
        assert(n_octaves >= 1);

        // Intial values, will be updated in make_zones().
        for (int d = 0; d < 2; d++) {
            dir[d].max_support = 0;
            dir[d].fat_min = INT_MAX;
            dir[d].fat_max = 0;
        }

        make_zones();

        // Make analysis plans

        unsigned int size_min = next_power_of_two(dir[0].fat_min * 2 + 1);
        // Deal with PFFFT's minimum FFT size.  Since dsplan.sftsize
        // will be half of size, we need to make size at least twice
        // the minimum.
        set_max(size_min, (unsigned int) GABORATOR_MIN_FFT_SIZE * 2);

        unsigned int size_max = next_power_of_two(dir[0].fat_max * 2 + 1);
        set_max(size_max, (unsigned int) GABORATOR_MIN_FFT_SIZE * 2);

        // Create the smmallest possible plan
        dir[0].plans.emplace_back(rpool, &ds, false, size_min);
        // Create larger plans
        size_max <<= GABORATOR_N_BIG_PLANS;
        for (unsigned int size = size_min; size < size_max;) {
            size *= 2;
            dir[0].plans.emplace_back(rpool, &ds, false, size);
        }

        if (params.synthesis) {
            // Make synthesis plan (only one for now)
            // Make room for at least the two fats + as much filet
            unsigned int size = next_power_of_two(dir[1].fat_max * 2) * 2;
            dir[1].plans.emplace_back(rpool, &ds, true, size);
        }

        for (int i = 0; i < (int) dir[0].plans.size(); i++)
            make_band_plans(i, false);
        for (int i = 0; i < (int) dir[1].plans.size(); i++)
            make_band_plans(i, true);

        for (int d = 0; d < 2; d++) {
            // Find the largest fftsize and sftsize of any plan
            for (size_t i = 0; i < dir[d].plans.size(); i++) {
                set_max(fftsize_max, dir[d].plans[i].fftsize);
                set_max(sftsize_max, dir[d].plans[i].sftsize_max);
            }
        }

        cmeta_any = make_meta();
    }

    void make_zones() {
        int zno = 0;
        // Loop over the octaves, from high to low frequencies,
        // creating new zones where needed
        for (int oct = 0; oct < n_octaves; oct++) {
            // First band in this octave
            int tbno = octaves[oct].n_bands_above;
            int bp_bands_remaining = n_bandpass_bands_total - tbno;
            // True if this octave contains the lowpass band
            bool dc_oct = params.scale->has_lowpass_band() &&
                (oct == n_octaves - 1);
            int bp_bands_this_octave = octaves[oct].n_bands - dc_oct;
            int bp_bands_below = bp_bands_remaining - bp_bands_this_octave;
            if (oct < 2 || oct >= n_octaves - 2 ||
                ! params.scale->octaves_repeat())
            {
                make_zone(oct, zno, tbno, tbno + bp_bands_this_octave,
                          dc_oct, bp_bands_below);
                zno++;
            }
            octaves[oct].z = zones[zno - 1].get();
        }
        assert((int) octaves.size() == n_octaves);
    }

    // Create a zone consisting of the bandpass bands band0
    // (inclusive) to band1 (exclusive), using the usual gbno
    // numbering going from high to low frequencies, and
    // possibly a lowpass band band1.

    void make_zone(int oct, int zno, int band0, int band1,
                   bool dc_zone, int bandpass_bands_below)
    {
        assert((int) zones.size() == zno);
        zone<T> *z = new zone<T>();
        z->zno = zno;
        zones.push_back(ref<zone<T>>(z));

        pod_vector<T> power;

        // Create the real (non-mock) bands, from high to low
        // frequency.
        // The actual (non-mock) bandpass bands of this zone
        for (int i = band0; i < band1; i++)
            push(z->bandparams, make_band(oct, i, false, false));
        if (dc_zone)
            // This zone has a lowpass band
            push(z->bandparams, make_band(oct, band1, true, false));

        if (! dc_zone && z->bandparams.size() >= 1) {
            // There are other zones below this one, and this one
            // contains at least one band.  Add mock bands to simulate
            // the zones below for purposes of calculating the dual.

            // Identify the lowest frequency of interest in the zone
            band_params<T> *low_band =
                z->bandparams[z->bandparams.size() - 1].get();
            double zone_bottom_ff = low_band->ff - low_band->ff_support;

            int i = band1;
            for (; i < band1 + bandpass_bands_below; i++) {
                band_params<T> *mock_band = make_band(oct, i, false, true);
                push(z->mock_bandparams, mock_band);
                // There's no point in creating further mock bands
                // once they no longer overlap with the current zone.
                // The condition used here may cause the creation of
                // one more mock band than is actually needed, as it
                // is easier to create the band first and check for
                // overlap later than the other way round.
                if (mock_band->ff + mock_band->ff_support < zone_bottom_ff) {
                    i++;
                    break;
                }
            }
            // Create a mock lowpass band.  This may correspond to the
            // actual lowpass band, or if the loop above exited early,
            // it may merely be be a placeholder to keep the power
            // from falling to (near) zero.  This not only makes the
            // power vector look better in plots, but also ensures
            // that when kernel sizes are rounded up to powers of two,
            // the extended tails don't blow up as a result of
            // dividing (almost) zero by (almost) zero.  This
            // placeholder lowpass band is needed even if the scale
            // has no actual lowpass band, in particular for mel
            // scales.
            if (i < (int) n_bands_total)
                push(z->mock_bandparams, make_band(oct, i, true, true));
        }

        // If there are other zones above this, add mock bands
        // to simulate them for purposes of calculating the dual,
        // but only up to the Nyquist frequency of the current
        // octave.
        if (zno > 0) {
            for (int i = band0 - 1; ; i--) {
                band_params<T> *mock_band = make_band(oct, i, false, true);
                if (mock_band->ff > 0.5) {
                    delete mock_band;
                    break;
                }
                push(z->mock_bandparams, mock_band);
            }
        }

        // Find the largest coefficient step in the zone, as this will
        // determine the necessary alignment of signal slices in time,
        // but make it at least two (corresponding to max_step_log2 = 1)
        // because the downsampling code requires alignement to even
        // indices.
        int m = 1;
        for (unsigned int obno = 0; obno < z->bandparams.size(); obno++) {
            set_max(m, z->bandparams[obno]->step_log2);
        }
        z->max_step_log2 = m;

        // Update the analyzer max_step_log2 member
        set_max(max_step_log2, m);

        // For each direction, find the largest time-domain
        // support of any band in terms of its octave sample rate
        // and store it for sizing FFTs.  Also find the largest
        // support in terms of the full sample rate and store it
        // in the analyzer object for the purpose of the public
        // analysis_support() / synthesis_support() method.
        for (int d = 0; d < 2; d++) {
            // Take the support of the downsampling filter into
            // account.  Since ds_time_support is in the unit of lower
            // octave samples, we need to multiply it by two to get
            // upper octave samples.
            z->dir[d].oct_support = analyzer::ds.time_support * 2.0;
            for (int gbno = band0; gbno < band1; gbno++) {
                double s = dir_support(gbno, d);
                set_max(z->dir[d].oct_support,
                        (int) ceil(ldexp(s, -bands[gbno].oct)));
                set_max(analyzer::dir[d].max_support, s);
            }

            // It may be possible to reduce the size of the fat from 1/4
            // of the fftsize, but we need to keep things aligned with the
            // coefficients, and it needs to be even for downsampling.
            int align = 1 << std::max(z->max_step_log2, 2);
            int fat_size =
                (z->dir[d].oct_support + (align - 1)) & ~(align - 1);
            z->dir[d].fat_size = fat_size;

            // Update minimum/maximum fat size if valid, i.e., if
            // the zone contains at least one band.
            if (band0 != band1) {
                set_min(analyzer::dir[d].fat_min, fat_size);
                set_max(analyzer::dir[d].fat_max, fat_size);
            }
        }
    } // make_zone

    // Calculate band parameters for a single band.
    //
    // If dc is true, this is the DC band, and gbno indicates
    // the cutoff frequency; it is one more than the gbno of
    // the lowest-frequency bandpass band.

    band_params<T> *
    make_band(int oct, double gbno, bool dc, bool mock) {
        band_params<T> *bp = new band_params<T>;
        if (dc)
            // Make the actual DC band cutoff frequency a bit higher,
            // by an empirically chosen fraction of a band, to reduce
            // power fluctuations.
            gbno -= 0.8750526596806952;

        // For bandpass bands, the center frequency, or for the
        // lowpass band, the lowpass cutoff frequency, as a
        // fractional frequency, in terms of the full signal
        // sample rate.
        double ff_global = bandpass_band_ff(gbno);

        // Ditto in terms of the octave's sample rate.
        double ff = ldexp(ff_global, oct);

        // Standard deviation of the bandpass Gaussian in units of
        // the octave's sample rate.
        double ffsd = ldexp(ff_sd(ff_global), oct);

        // The support of the Gaussian, i.e., the smallest standard
        // deviation at which it can be truncated on each side
        // without the error exceeding our part of the error budget,
        // which is some fraction of params.max_error.  Note
        // that this is one-sided; the full width of the support
        // is 2 * ff_support.
        double bp_ff_support = gaussian_support(ffsd, params.max_error * 0.5);
        // Additional support for the flat portion of the DC band lowpass
        double dc_support = dc ? ff : 0;
        // Total frequency-domain support for this band, one-sided
        double band_support = bp_ff_support + dc_support;
        // Total support needed for this band, two-sided
        double band_2support = band_support * 2;

        // Determine the downsampling factor for this band.
        int exp = 0;
        while (band_2support <= 0.5) {
            band_2support *= 2;
            exp++;
        }
        bp->dc = dc;
        bp->ff = ff;
        bp->ffsd = ffsd;
        bp->step_log2 = exp;
        bp->ff_support = band_support;

        // Calculate time domain support in octave subsamples
        for (int d = 0; d < 2; d++)
            bp->dir[d].time_support =
                ldexp(dir_support(gbno, d), -oct);

        return bp;
    }

    // Given a fractional frequency, return the standard deviation
    // of the frequency-domain window as a fractional frequency.
    double ff_sd(double ff) const {
        return params.overlap * params.scale->band_spacing_at(ff);
    }

    // Given a fractional frequency, return the standard deviation
    // of the time-domain window in samples.
    //
    // ff_sd = 1.0 / (tau * t_sd)
    // per http://users.ece.gatech.edu/mrichard/
    // Gaussian%20FT%20and%20random%20process.pdf
    // and python test program gaussian-overlap.py
    // => (tau * t_sd) * ff_sd = 1.0
    // => t_sd = 1.0 / (tau * f_sd)
    double time_sd(double ff) const {
        return 1.0 / (tau * ff_sd(ff));
    }

    // Find the time support of the filter for direction "d" (analysis
    // or synthesis) for bandpass band number gbno.  This is the
    // largest distance in time between a signal sample and a
    // coefficient affected by that sample.
    double dir_support(int gbno, int d) const {
        double s = gaussian_support(time_sd(bandpass_band_ff(gbno)),
                                   params.max_error);
        if (d == params.eq_dir) {
            s *= eq_support_multiplier();
            // Allow extra support due to non-Gaussian filter shapes
            // near Nyquist.  Empirically, this is causing roughly
            // exponential fall-off instead of the Gaussian
            // exponential-of-square fall-off.
            // XXX instead of gbno <= 2, should instead check if Gaussian reaches Nyquist
            if (gbno <= 2) {
                // The logarithm base does not matter
                double s_top = log2(params.max_error) / log2(max_error_default) *
                    time_sd(bandpass_band_ff(gbno)) * 16.00168510978225 / params.overlap;
                set_max(s, s_top);
            }
        }
        return s;
    }

    // Find the time support of the analysis filter for bandpass band
    // number gbno.
    double band_analysis_support(int gbno) const {
        return dir_support(gbno, 0);
    }

    // Find the largest time support of any analysis filter.
    double analysis_support() const {
        return dir[0].max_support;
    }

    // Ditto for the synthesis filters.
    double band_synthesis_support(int gbno) const {
        return dir_support(gbno, 1);
    }

    double synthesis_support() const {
        return dir[1].max_support;
    }

    // The equalization support multiplier, a conservative estimate of
    // the factor by which the filter time domain support increases
    // due to equalization.
    double eq_support_multiplier() const {
        if (! params.synthesis)
            return 1.0;
        return std::max(2.3, params.scale->eq_support_multiplier());
    }

    // Forwarding functions for backwards compatibility
    double bandpass_band_ff(double gbno) const {
        return params.scale->bandpass_band_ff(gbno);
    }
    double ff_bandpass_band(double ff) const {
        return params.scale->ff_bandpass_band(ff);
    }
    double band_q(double band) const {
        double ff = bandpass_band_ff(band);
        return ff / (2 * sqrt(log(2)) * ff_sd(ff));
    }

private:
    void
    synthesize_one_slice(int oct, int pno, const coefs<T> &msc,
                         const pod_vector<T> &downsampled,
                         sample_index_t t0,
                         T *signal_out,
                         pod_vector<C> &buf0, // fftsize
                         pod_vector<C> &buf2, // largest sftsize
                         pod_vector<C> &buf3  // largest sftsize
                         ) const
    {
        const auto &plan(dir[1].plans[pno]);
        zone<T> &z = *octaves[oct].z;
        pod_vector<C> &signal(buf0);
        std::fill(signal.begin(), signal.end(), (T) 0);

        pod_vector<C> &coefbuf(buf3);

        for (unsigned int obno = 0; obno < z.bandparams.size(); obno++) {
            band_params<T> *bp = z.bandparams[obno].get();
            band_plan<T> *bpl = &bp->dir[1].plans[pno];

            // log2 of the coefficient downsampling factor
            int coef_shift = bp->step_log2;
            coef_index_t ii = t0 >> coef_shift;

            read(msc, bno_merge(oct, obno), ii, ii + bpl->sftsize,
                 coefbuf.data());

            pod_vector<C> &sdata(buf2);

            // Adjust phase for non-integer center frequency and
            // phase convention, and scale amplitude.
            // Input is in coefbuf, output is in sdata.
            if (params.phase == coef_phase::global) {
                // Phase depends on the buffer start time.
                // Note the use of double precision for phase values.
                // We can't use bp->ff here because in the case of the
                // lowpass band, it's the cutoff rather than the center.
                double ff = bpl->center * plan.inv_fftsize_double;
                double arg = tau * t0 * ff;
                C phase = C(cos(arg), sin(arg));
                elementwise_product_times_scalar
                    (sdata.data(), coefbuf.data(),
                     bpl->dir[1].shift_kernel.data(),
                     phase, bpl->sftsize);
            } else {
                // Phase does not depend on the buffer start time.
                elementwise_product(sdata.data(), coefbuf.data(),
                                    bpl->dir[1].shift_kernel.data(),
                                    bpl->sftsize);
            }

            // Switch to frequency domain
            // Input is in sdata, output is back in coefbuf
            bpl->sft->transform(sdata.data(), coefbuf.data());

            // Multiply signal spectrum by frequency-domain dual window,
            // accumulating result in signal.

            for (unsigned int i = 0; i < bpl->sftsize; i++) {
                int iii = (bpl->fq_offset_int + i) & (plan.fftsize - 1);
                // Note the ifftshift of the input index, as f=0
                // appears in the middle of the window
                C v = coefbuf[i ^ (bpl->sftsize >> 1)] * bpl->dir[1].kernel[i];
                // Frequency symmetry
                signal[iii] += v;
                if (!(bp->ff == 0.0 || bp->ff == 0.5))
                    signal[-iii & (plan.fftsize - 1)] += conj(v);
            }
        }

        if (oct + 1 < n_octaves) {
            // Upsample the downsampled data from the lower octaves
            pod_vector<C> &sdata(buf2);
            assert(downsampled.size() == plan.dsplan.sftsize);
            assert(sdata.size() >= plan.dsplan.sftsize);
            plan.dsplan.rsft->transform(downsampled.data(), sdata.begin());

            for (unsigned int i = 0; i < plan.dsplan.sftsize; i++) {
                sdata[i] *= plan.dsplan.dir[1].kernel
                    [i ^ (plan.dsplan.sftsize >> 1)];
            }

            // This implicitly zero pads the spectrum, by not adding
            // anything to the middle part.  The splitting of the
            // Nyquist band is per http://dsp.stackexchange.com/
            // questions/14919/upsample-data-using-ffts-how-is-this-
            // exactly-done but should not really matter because there
            // should be no energy there to speak of thanks to the
            // windowing above.

            assert(plan.dsplan.sftsize == plan.fftsize / 2);
            unsigned int i;
            for (i = 0; i < plan.dsplan.sftsize / 2; i++)
                signal[i] += sdata[i];
            C nyquist = sdata[i] * (T) 0.5;
            signal[i] += nyquist;
            signal[i + plan.fftsize / 2] += nyquist;
            i++;
            for (;i < plan.dsplan.sftsize; i++)
                signal[i + plan.fftsize / 2] += sdata[i];
        }

        // Switch to time domain
        plan.rft->itransform(signal.data(), signal_out);
    }

    // Synthesize audio from the coefficients in "msc".  The audio will
    // cover samples from t0 (inclusive) to t1 (exclusive), and is stored
    // starting at *real_signal, which must have room for (t1 - t0)
    // samples.  The octave "oct" is 0 except in recursive calls.

    void
    synthesize_sliced(int oct, const coefs<T> &msc,
                      sample_index_t t0, sample_index_t t1,
                      T *real_signal) const
    {
        int pno = 0; // For now
        const auto &plan(dir[1].plans[pno]);
        unsigned int fat_size = plan.fftsize >> 2;
        unsigned int filet_size = plan.fftsize >> 1;

        const zone<T> &z = *octaves[oct].z;

        // Find indices of first/last slice affected by sample range
        //
        // fft number i covers the sample range
        // t = (i * filetsize .. i * filetsize + (fftsize - 1))
        // t >= i * filetsize and t < i * filetsize + fftsize
        // A sample at t affects ffts i where
        //   i <= t / filetsize and
        //   i > (t - fftsize) / filetsize
        // the filet of fft number i covers the sample range
        // (fat + (i * filetsize) .. fat + (i * filetsize) + (filetsize - 1))
        //
        // However, due to the FFT size being rounded up to a power of two,
        // the outermost parts have near-zero weights and can be ignored;
        // this is done by adjusting the time values by the width of that
        // outermost part, which is (fatsize - support)

        int oct_support = z.dir[1].oct_support;

        auto affected_slice_b =
        [](unsigned int fftsize, int support, sample_index_t i0)
            -> slice_index_t
        {
            return floor_div(i0 - fftsize + (fat_part(fftsize) - support),
                             filet_part(fftsize)) + 1;
        };

        auto affected_slice_e =
        [](unsigned int fftsize, int support, sample_index_t i1)
            -> slice_index_t
        {
            return floor_div(i1 - 1 - (fat_part(fftsize) - support),
                             filet_part(fftsize)) + 1;
        };

        slice_index_t si0 = affected_slice_b(plan.fftsize, oct_support, t0);
        slice_index_t si1 = affected_slice_e(plan.fftsize, oct_support, t1);

        // sub_signal holds the reconstructed subsampled signal from
        // the lower octaves, for the entire time interval covered by
        // the slices
        int sub_signal_len =
            ((si1 - si0) * filet_size + 2 * fat_size) / 2;
        pod_vector<T> sub_signal(sub_signal_len);
        std::fill(sub_signal.begin(), sub_signal.end(), (T) 0);
        if (oct + 1 < n_octaves) {
            int64_t sub_t0 = si0 * (filet_size / 2);
            int64_t sub_t1 = sub_t0 + sub_signal_len;
            // Recurse
            assert(sub_t1 - sub_t0 == (int64_t) sub_signal.size());
            synthesize_sliced(oct + 1, msc, sub_t0, sub_t1, sub_signal.data());
        }

        // Allocate buffers for synthesize_one_slice(), to be shared
        // between successive calls to avoid repeated allocation
        pod_vector<C> buf0(plan.fftsize);
        //pod_vector<C> buf1(fftsize);
        pod_vector<C> buf2(plan.sftsize_max);
        pod_vector<C> buf3(plan.sftsize_max);

        pod_vector<T> downsampled(plan.dsplan.sftsize);
        pod_vector<T> signal_slice(plan.fftsize);

        // For each slice
        for (slice_index_t si = si0; si < si1; si++) {
            sample_index_t slice_t0 = si * filet_size;

            // Copy downsampled signal to "downsampled" for upsampling
            if (oct + 1 < n_octaves) {
                int bi = (si - si0) * filet_part(plan.dsplan.sftsize);
                int ei = bi + plan.dsplan.sftsize;
                assert(bi >= 0);
                assert(ei <= (int) sub_signal.size());
                std::copy(sub_signal.begin() + bi,
                          sub_signal.begin() + ei,
                          downsampled.begin());
            }

            synthesize_one_slice(oct, pno, msc, downsampled, slice_t0,
                                 signal_slice.data(), buf0, buf2, buf3);

            // Copy overlapping part
            sample_index_t b =
                std::max(slice_t0 + fat_size, t0);
            sample_index_t e =
                std::min(slice_t0 + plan.fftsize - fat_size, t1);
            for (sample_index_t i = b; i < e; i++)
                real_signal[i - t0] = signal_slice[i - slice_t0];
        }
    }

public:
    // The main analysis entry point.
    // The resulting coefficients are added to any existing
    // coefficients in "msc".

    void analyze(const T *real_signal, sample_index_t t0, sample_index_t t1,
                 coefs<T> &msc, int n_threads = 1) const
    {
        analyze1(real_signal, t0, t1, msc, n_threads, 1);
    }

    void analyze1(const T *real_signal, sample_index_t t0, sample_index_t t1,
                  coefs<T> &msc, int n_threads, int level) const
    {
        (void)n_threads;
        analyze2(real_signal, t0, t1, msc, n_threads, level);
    }

    void analyze2(const T *real_signal, sample_index_t t0, sample_index_t t1,
                  coefs<T> &msc, int n_threads, int level) const
    {
        // XXX split?
        buffers<T> bufs(fftsize_max, sftsize_max);
        analyze_sliced(*this, bufs, 0, real_signal, t0, t1, 0.0,
                       // Spectrum callback
                       [this, &bufs, &msc]
                       (int oct,
                        int pno,
                        const plan<T> &plan,
                        C *spectrum,
                        // buf_t0 is the time of the first sample in
                        // the buffer whose spectrum we are processing
                        // (beginning of fat, not filet)
                        sample_index_t buf_t0,
                        sample_index_t t0,
                        sample_index_t t1
                       )
        {
            zone<T> &z = *octaves[oct].z;

            auto tmp(bufs.template get<C>(2, plan.sftsize_max));
            auto coefbuf(bufs.template get<C>(4, plan.sftsize_max));

            for (unsigned int obno = 0; obno < z.bandparams.size(); obno++) {
                band_params<T> *bp = z.bandparams[obno].get();
                band_plan<T> *bpl = &bp->dir[0].plans[pno];
                C *sdata = tmp.data();

                // Multiply a slice of the spectrum by the frequency-
                // domain window and store in sdata.
                //
                // We need to take care not to overrun the beginning or
                // end of the spectrum - for the dc band, we always
                // need to wrap around to negative frequencies, and
                // potentially it could happen with other bands, too,
                // if they are really wide.  To avoid the overhead of
                // checking in the inner loop, use a separate slow path
                // for the rare cases where wrapping happens.

                int start_index = bpl->fq_offset_int;
                int end_index = bpl->fq_offset_int + bpl->sftsize;
                if (start_index >= 0 &&
                    end_index < (int)((plan.fftsize >> 1) + 1))
                {
                    // Fast path: the slice lies entirely within the
                    // positive-frequency half of the spectrum (including
                    // DC and Nyquist).
                    elementwise_product(sdata,
                                        spectrum + start_index,
                                        bpl->dir[0].kernel.data(),
                                        bpl->sftsize);
                } else {
                    // Slow path
                    for (size_t i = 0; i < bpl->sftsize; i++)
                        sdata[i] = get_real_spectrum_coef(spectrum,
                            (int)(start_index + i), plan.fftsize) *
                            bpl->dir[0].kernel[i];
                }
                // The band center frequency is at the center of the
                // spectrum slice and at the center of the window, so
                // it also ends up at the center of sdata.  The center
                // frequency of the band is considered f=0, so for the
                // ifft, it should be at index 0, not the center.
                // Therefore, in principle we should perform an
                // ifftshift of sdata here before the ifft, but since
                // the time-domain data are going to be multiplied by
                // the shift kernel anyway, the ifftshift is baked
                // into the shift kernel by flipping the sign of every
                // other element so that it is effectively free.

                // Switch to time domain
                auto band(bufs.template get<C>(3, plan.sftsize_max));
                bpl->sft->itransform(sdata, band.data());

                // Apply ifftshift, adjust phase for non-integer center
                // frequency and phase convention, and scale amplitude.
                if (params.phase == coef_phase::global) {
                    // Phase depends on the buffer start time
                    double ff = bpl->center * plan.inv_fftsize_double;
                    double arg = -tau * buf_t0 * ff;
                    C phase = C(cos(arg), sin(arg));
                    elementwise_product_times_scalar(coefbuf.data(), band.data(),
                                                     bpl->dir[0].shift_kernel.data(),
                                                     phase,
                                                     bpl->sftsize);
                } else {
                    // Phase does not depend on the buffer start time
                    elementwise_product(coefbuf.data(), band.data(),
                                        bpl->dir[0].shift_kernel.data(),
                                        bpl->sftsize);
                }

                // log2 of the coefficient downsampling factor
                int coef_shift = bp->step_log2;
                coef_index_t ii = shift_right_exact(buf_t0, coef_shift);

                // Add the new coefficients to the output coefficients.
                // Only part of coefbuf contains substantially nonzero
                // data: that corresponding to the signal interval
                // t0..t1 + the actual support of the filter for this band.
                // There's no point adding the zeros to the coefficients,
                // so trim.
                int support = (int) ceil(bp->dir[0].time_support);
                coef_index_t ii0 = std::max(ii, (t0 - support) >> coef_shift);
                coef_index_t ii1 = std::min(ii + bpl->sftsize,
                                            ((t1 + support) >> coef_shift) + 1);
                add(msc, bno_merge(oct, obno), ii0, ii1, coefbuf.data() + (ii0 - ii));
            }
        },
        nop());
    }

    // The main synthesis entry point

    void
    synthesize(const coefs<T> &msc, sample_index_t t0, sample_index_t t1,
               T *real_signal, int n_threads = 1) const
    {
        assert(params.synthesis);
        (void)n_threads;
        synthesize_sliced(0, msc, t0, t1, real_signal);
    }

    // Split a global band number "gbno" into an octave number "oct"
    // and a band number within the octave "obno" per the analysis
    // octave structure.

    bool bno_split(int gbno, int &oct, unsigned int &obno) const {
        if (gbno < 0 || gbno >= (int) bands.size())
            return false;
        const band_info &bi(bands[gbno]);
        oct = bi.oct;
        obno = bi.obno;
        return true;
    }

    int bno_merge(int oct, unsigned int obno) const {
        return obno + octaves[oct].n_bands_above;
    }

    // Get the bounds of the range of existing coefficients for all bands,
    // in units of signal samples.
    void get_coef_bounds(const coefs<T> &msc,
                         sample_index_t &si0_ret, sample_index_t &si1_ret)
        const
    {
        // The greatest coefficient range typically occurs in the
        // lowest bandpass band, but this is not always the case,
        // so to be certain, check them all.
        sample_index_t min_si0 = INT64_MAX;
        sample_index_t max_si1 = INT64_MIN;
        for (int band = bands_begin(); band != bands_end(); band++) {
            coef_index_t ci0, ci1;
            get_band_coef_bounds(msc, band, ci0, ci1);
            // Convert from coefficient samples to signal samples
            int exp = band_scale_exp(band);
            sample_index_t si0 = shift_left(ci0, exp);
            sample_index_t si1 = shift_left(ci1 - 1, exp) + 1;
            set_min(min_si0, si0);
            set_max(max_si1, si1);
        }
        si0_ret = min_si0;
        si1_ret = max_si1;
    }

    // XXX shouldn't need both this and band_scale_exp(int)
    unsigned int band_step_log2(int gbno) const {
        return band_scale_exp(gbno);
    }

    int bandpass_bands_begin() const { return 0; }
    int bandpass_bands_end() const { return n_bandpass_bands_total; }

    int bands_begin() const { return 0; }
    int bands_end() const { return n_bands_total; }

    bool has_lowpass_band() const {
        return params.scale->has_lowpass_band();
    }
    int band_lowpass() const {
        assert(params.scale->has_lowpass_band());
        return n_bands_total - 1;
    }
    int band_ref() const {
        // This will abort if the scale does not have a reference band
        return params.scale->band_ref();
    }

    // Get the center frequency of band number gbno as a fractional
    // frequency.  gbno must be a valid band number.  For the lowpass
    // band, this returns zero.
    double band_ff(int gbno) const {
        if (params.scale->has_lowpass_band() && gbno == band_lowpass())
            return 0;
        return bandpass_band_ff(gbno);
    }

    ~analyzer() {
    }

    // Get the base 2 logarithm of the downsampling factor of
    // band "obno" in octave "oct"
    int band_scale_exp(int oct, unsigned int obno) const {
        zone<T> &z = *octaves[oct].z;
        band_params<T> *bp = z.bandparams[obno].get();
        return bp->step_log2 + oct;
    }

    // Get the base 2 logarithm of the downsampling factor of
    // band "gbno"
    int band_scale_exp(int gbno) const {
        int oct;
        unsigned int obno; // Band number within octave
        bool r = bno_split(gbno, oct, obno);
        assert(r);
        return band_scale_exp(oct, obno);
    }

    // Get the base 2 logarithm of the highest downsampling factor of
    // any band
    int band_scale_exp_max() const {
        return band_scale_exp(bandpass_bands_end() - 1);
    }


    // Find the sample time of the band "gbno" coefficient closest to
    // time "t".  "gbno" must be a valid band number.
    sample_index_t nearest_coef_sample(int gbno, double t) const {
        int shift = band_step_log2(gbno);
        return shift_left((sample_index_t) round(ldexp(t, -shift)), shift);
    }
    // Find the highest coefficient sample time less than or equal to
    // "t" for band "gbno".  "gbno" must be a valid band number.
    sample_index_t floor_coef_sample(int gbno, double t) const {
        int shift = band_step_log2(gbno);
        return shift_left((sample_index_t) floor(ldexp(t, -shift)), shift);
    }
    // Find the lowestt coefficient sample time greater than or equal
    // to "t" for band "gbno".  "gbno" must be a valid band number.
    sample_index_t ceil_coef_sample(int gbno, double t) const {
        int shift = band_step_log2(gbno);
        return shift_left((sample_index_t) ceil(ldexp(t, -shift)), shift);
    }

    // Calculate per-plan, per-band coefficients for plan "pno",
    // a synthesis plan if "syn" is true, otherwise an analysis plan.

    void make_band_plans(int pno, bool syn) {
        const auto &plan(dir[syn].plans[pno]);

        for (int zno = 0; zno < (int) zones.size(); zno++) {
            zone<T> *z = zones[zno].get();

            make_band_plans_2(z->bandparams, pno, syn, false);
            make_band_plans_2(z->mock_bandparams, pno, syn, true);

            if (plan.dir == params.eq_dir) {
                // Accumulate window power for calculating dual
                std::vector<T> power(plan.fftsize);
                // Real bands
                for (unsigned int i = 0; i < z->bandparams.size(); i++) {
                    band_params<T> *bp = z->bandparams[i].get();
                    band_plan<T> *bpl = &bp->dir[syn].plans[pno];
                    accumulate_power(plan, bp, bpl, power.data());
                }
                // Mock bands
                for (unsigned int i = 0; i < z->mock_bandparams.size(); i++) {
                    band_params<T> *bp = z->mock_bandparams[i].get();
                    band_plan<T> *bpl = &bp->dir[syn].plans[pno];
                    accumulate_power(plan, bp, bpl, power.data());
                }

                // Calculate duals
                for (unsigned int obno = 0;
                     obno < z->bandparams.size();
                     obno++)
                {
                    band_params<T> *bp = z->bandparams[obno].get();
                    band_plan<T> *bpl = &bp->dir[syn].plans[pno];
                    for (unsigned int i = 0; i < bpl->sftsize; i++) {
                        // ii = large-FFT bin number
                        int ii = i + bpl->fq_offset_int;
                        bpl->dir[params.eq_dir].kernel[i] /=
                            power[ii & (plan.fftsize - 1)];
                    }
#if 0
                    // The analysis kernels are no longer needed
                    bpl->dir[0].kernel = std::vector<T>();
                    bpl->dir[0].shift_kernel = pod_vector<C>();
#endif
                }
                //z->mock_bandparams.clear(); // No longer safe, may be needed
                // by another plan
            }

            // Scale the kernels
            for (unsigned int b = 0; b < z->bandparams.size(); b++) {
                band_params<T> *bp = z->bandparams[b].get();
                band_plan<T> *bpl = &bp->dir[syn].plans[pno];
                T scale[2] = {
                    // Analysis
                    (T) params.coef_scale * plan.inv_fftsize_t,
                    // Synthesis
                    (T) 1 / ((T) params.coef_scale * bpl->sftsize)
                };
                for (int d = 0; d < 2; d++) {
                    for (unsigned int i = 0; i < bpl->sftsize; i++)
                        bpl->dir[d].kernel[i] *= scale[d];
                }
            }
        }
    }

    void make_band_plans_2(std::vector<ref<band_params<T>>> &bv, int pno,
                           bool syn, bool mock)
    {
        auto &plan(dir[syn].plans[pno]);

        for (unsigned int obno = 0; obno < bv.size(); obno++) {
            band_params<T> *bp = bv[obno].get();
            std::vector<band_plan<T>> *bplv = &bp->dir[syn].plans;
            // XXX redundant resizes
            bplv->resize(dir[syn].plans.size());
            band_plan<T> *bpl = &(*bplv)[pno];

            // Note that bp->step_log2 cannot be negative, meaning
            // that the bands can only be subsampled, not oversampled.
            unsigned int sftsize = plan.fftsize >> bp->step_log2;

            // Deal with PFFFT's minimum FFT size
            set_max(sftsize, (unsigned int) GABORATOR_MIN_FFT_SIZE);

            bpl->sftsize = sftsize;
            bpl->sftsize_log2 = whichp2(bpl->sftsize);

            if (! mock) {
                set_max(plan.sftsize_max, bpl->sftsize);
                bpl->sft = rpool->ft.get(bpl->sftsize);
            }

            for (int d = 0; d < 2; d++) {
                bpl->dir[d].kernel.resize(bpl->sftsize);
                bpl->dir[d].shift_kernel.resize(bpl->sftsize);
            }

            if (bp->dc)
                bpl->center = 0;
            else
                bpl->center = bp->ff * plan.fftsize;
            bpl->icenter = (int) rint(bpl->center);
            bpl->fq_offset_int = bpl->icenter - (bpl->sftsize >> 1);

            // Calculate frequency-domain window kernel, possibly with
            // wrap-around
            for (int d = 0; d < 2; d++)
                for (unsigned int i = 0; i < bpl->sftsize; i++)
                    bpl->dir[d].kernel[i] = 0;
            // i loops over the kernel, with i=0 at the center.
            // The range is twice the support on each side so that
            // any excess space in the kernel due to rounding up
            // the size to a power of two is filled in with actual
            // Gaussian values rather than zeros.
            int fq_support = (int) ceil(bp->ff_support * plan.fftsize);
            for (int i = - 2 * fq_support; i < 2 * fq_support; i++) {
                // ii = large-FFT band number of this kernel sample
                int ii = i + bpl->fq_offset_int + (int) bpl->sftsize / 2;
                // this_ff = fractional frequency of this kernel sample
                double this_ff = ii * plan.inv_fftsize_double;
                // ki = kernel index
                int ki = ii - bpl->fq_offset_int;
                // When sftsize == fftsize, the support of the kernel can
                // exceed sftsize, and in this case, it should be allowed
                // to wrap so that it remains smooth.  When sftsize < fftsize,
                // sftsize is large enough for the support and no wrapping
                // is needed or wanted.
                if (bpl->sftsize == plan.fftsize && !mock) {
                    bpl->dir[0].kernel[ki & (plan.fftsize - 1)] +=
                        eval_kernel(&params, bp, this_ff);
                    bpl->dir[1].kernel[ki & (plan.fftsize - 1)] +=
                        eval_dual_kernel(&params, bp, this_ff);
                } else {
                    if (ki >= 0 && ki < (int) bpl->dir[0].kernel.size()) {
                        bpl->dir[0].kernel[ki] +=
                            eval_kernel(&params, bp, this_ff);
                        bpl->dir[1].kernel[ki] +=
                            eval_dual_kernel(&params, bp, this_ff);
                    }
                }
            }
        }

        // Calculate complex exponentials for non-integer center
        // frequency adjustment and phase convention adjustment
        for (unsigned int obno = 0; obno < bv.size(); obno++) {
            band_params<T> *bp = bv[obno].get();
            band_plan<T> *bpl = &bp->dir[syn].plans[pno];
            for (unsigned int i = 0; i < bpl->sftsize; i++) {
                double center =
                    (params.phase == coef_phase::global) ? bpl->center : 0;
                double arg = tau * ((double)i / bpl->sftsize) *
                    -(center - bpl->icenter);
                C t(cos(arg), sin(arg));
                // Apply ifftshift of spectrum in time domain
                bpl->dir[0].shift_kernel[i] = (i & 1) ? -t : t;
                // Conjugate kernel does not have ifftshift
                bpl->dir[1].shift_kernel[i] = conj(t);
            }
        }
    }

    // Add the power of the kernel in "*bp" to "power"
    void
    accumulate_power(const plan<T> &plan, band_params<T> *bp,
                     band_plan<T> *bpl, T *power)
    {
        for (unsigned int i = 0; i < bpl->sftsize; i++) {
            // ii = large-FFT bin number
            unsigned int ii = i + bpl->fq_offset_int;
            ii &= plan.fftsize - 1;
            assert(ii >= 0 && ii < plan.fftsize);
            T p = bpl->dir[0].kernel[i] * bpl->dir[1].kernel[i];
            power[ii] += p;
            if (!(bp->ff == 0.0 || bp->ff == 0.5)) {
                unsigned int ni = -ii;
                ni &= plan.fftsize - 1;
                power[ni] += p;
            }
        }
    }

    // Create coefficient metadata
    coefs_meta *make_meta() const {
        coefs_meta *cmeta = new coefs_meta;
        cmeta->slice_len_log2 = 8; // XXX tune
        cmeta->n_bands_total = n_bands_total;
        cmeta->n_bandpass_bands_total = n_bandpass_bands_total;
        cmeta->bands.resize(n_bands_total);
        // Find each contiguous range of bands having the same
        // coefficient step
        int band = 0;
        while (band < (int) n_bands_total) {
            int band0 = band;
            int shift = band_step_log2(band0);
            while (band < (int) n_bands_total &&
                   (int) band_step_log2(band) == shift)
            {
                cmeta->bands[band].oct = (int) cmeta->octaves.size();
                cmeta->bands[band].obno = band - band0;
                band++;
            }
            int band1 = band;
            oct_coefs_meta ocm;
            ocm.cmeta = cmeta;
            ocm.step_log2 = shift;
            ocm.n_bands = band1 - band0;
            ocm.n_bands_above = band0;
            cmeta->octaves.push_back(ocm);
        }
        cmeta->n_octaves = (int) cmeta->octaves.size();
        return cmeta;
    }

    analyzer(const analyzer &) = delete;
    analyzer &operator=(const analyzer &) = delete;

    // Accessors for analyze_sliced()

    // Get the number of octaves
    int get_n_octaves() const {
        return n_octaves;
    }

    // Get the amount of padding needed in octave "oct"
    unsigned int fat_size(int oct) const {
        zone<T> &z = *octaves[oct].z;
        return z.dir[0].fat_size;
    }

    // Get the minimum alignment needed in octave "oct"
    int align(int oct) const {
        zone<T> &z = *octaves[oct].z;
        return 1 << z.max_step_log2;
    }

    // Data members

    parameters params;
    resource_pool<T> my_rpool; // Default FFT pool
    resource_pool<T> *rpool; // User-selected FFT pool
    int max_step_log2; // Largest step size of any band
    unsigned int fftsize_max; // Largest FFT size of any plan
    unsigned int sftsize_max; // Largest SFT size of any plan
    unsigned int n_bandpass_bands_total;
    unsigned int n_bands_total; // Total number of frequency bands, including DC

    std::vector<band_info> bands;
    std::vector<octave<T>> octaves; // Per-octave parameters
    std::vector<ref<zone<T>>> zones;

    // Per-direction part
    struct {
        // The largest support of any band, in signal samples.
        double max_support;
        // Smallest and largest amount of padding (including
        // alignment) needed in any zone, in octave subsamples.
        // Used for sizing the plans to ensure that they cover
        // the full range of padding used in the different zones.
        int fat_min;
        int fat_max;
        std::vector<plan<T>> plans;
    } dir[2];

    int n_octaves;

    ds_filter ds; // Downsampling filter

    ref<coefs_meta> cmeta_any;
};


// Iterate over the slices of a row (band) having slice length
// 2^sh that contain coefficients with indices ranging from i0
// (inclusive) to i1 (exclusive), and call the function f for
// each such slice (full or partial), with the arguments
//
//  sli - slice index
//  bvi - index of first coefficient to process within the slice
//  len - number of coefficients to process within the slice

template <class F>
void foreach_slice(int sh, coef_index_t i0, coef_index_t i1, F f) {
    // Note that this can be called with i0 > i1 and needs to handle
    // that case gracefully.
    // Band size (power of two)
    int bsize = 1 << sh;
    coef_index_t i = i0;
    while (i < i1) {
        // Slice index
        slice_index_t sli = i >> sh;
        // Band vector index
        unsigned int bvi = (unsigned int)(i & (bsize - 1));
        unsigned int len = bsize - bvi;
        unsigned int remain = (unsigned int)(i1 - i);
        if (remain < len)
            len = remain;
        f(sli, bvi, len);
        i += len;
    }
}

// Like foreach_slice, but call the "process_existing_slice" method of
// the given "dest" object for each full or partial slice of
// coefficients, and/or the "process_missing_slice" method for each
// nonexistent slice.
//
// Template parameters:
//   T is the spectrogram value type
//   D is the dest object type
//   C is the coefficient type

template <class T, class D, class C = complex<T>>
struct row_foreach_slice {
    typedef C value_type;
    row_foreach_slice(const coefs<T, C> &msc,
                      int oct_, unsigned int obno_):
        oct(oct_), obno(obno_), sc(msc.octaves[oct]),
        sh(sc.ometa->cmeta->slice_len_log2)
    {
        assert(oct < (int) msc.octaves.size());
    }
public:
    void operator()(coef_index_t i0, coef_index_t i1, D &dest) const {
        foreach_slice(sh, i0, i1,
            [this, &dest](slice_index_t sli, unsigned int bvi, unsigned int len) {
                oct_coefs<C> *c = get_existing_ptr(sc, sli);
                if (c) {
                    dest.process_existing_slice(c->bands[obno] + bvi, len);
                } else {
                    dest.process_missing_slice(len);
                }
            });
    }
    int oct;
    unsigned int obno;
    const sliced_coefs<C> &sc;
    int sh;
};

// Helper class for row_source

template <class C, class OI>
struct writer_dest {
    writer_dest(OI output_): output(output_) { }
    void process_existing_slice(C *bv, size_t len) {
        // Can't use std::copy here because it takes the output
        // iterator by value, and using the return value does not
        // work, either.
        for (size_t i = 0; i < len; i++)
            *output++ = bv[i];
    }
    void process_missing_slice(size_t len) {
        for (size_t i = 0; i < len; i++)
            *output++ = C();
    }
    OI output;
};

// Retrieve a sequence of coefficients from a row (band) in the
// spectrogram, with indices ranging from i0 to i1.  The coefficients
// are written through the output iterator "output".
//
// The indices can be negative, and can extend outside the available
// data, in which case coefficients of zero are produced.
//
// Template arguments:
//   T is the spectrogram value type
//   OI is the output iterator type
//   C is the coefficient value type
// Note defaults for template arguments defined in forward declaration.

template <class T, class OI, class C>
struct row_source {
    row_source(const coefs<T, C> &msc_,
               int oct_, unsigned int obno_):
        slicer(msc_, oct_, obno_)
    { }
    OI operator()(coef_index_t i0, coef_index_t i1, OI output) const {
        writer_dest<C, OI> dest(output);
        slicer(i0, i1, dest);
        return dest.output;
    }
    row_foreach_slice<T, writer_dest<C, OI>, C> slicer;
};

// The opposite of row_source: store a sequence of coefficients into
// a row (band) in the spectrogram.  This duplicates quite a lot of
// the row_source code above (without comments); the main part that's
// different is marked by the comments "Begin payload" and "End
// payload".  Other differences: iterator is called II rather than OI,
// and the coefs are not const.

template <class T, class II, class C>
struct row_dest {
    typedef C value_type;
    row_dest(coefs<T, C> &msc,
             int oct_, unsigned int obno_):
        oct(oct_), obno(obno_), sc(msc.octaves[oct]),
        sh(sc.ometa->cmeta->slice_len_log2)
    {
        assert(oct < (int) msc.octaves.size());
    }
public:
    II operator()(coef_index_t i0, coef_index_t i1, II input) const {
        assert(i0 <= i1);
        int bsize = 1 << sh;
        coef_index_t i = i0;
        while (i < i1) {
            slice_index_t sli = i >> sh;
            unsigned int bvi = i & (bsize - 1);
            unsigned int len = bsize - bvi;
            unsigned int remain = (unsigned int)(i1 - i);
            if (remain < len)
                len = remain;
            int bvie = bvi + len;
            // Begin payload
            oct_coefs<C> *c = get_or_create_ptr(sc, sli);
            C *bv = c->bands[obno];
            for (int j = bvi; j < bvie; j++)
                bv[j] = *input++;
            i += len;
            // End payload
        }
        return input;
    }
    int oct;
    unsigned int obno;
    sliced_coefs<C> &sc;
    unsigned int sh;
};

// One more set of duplicated code, now for adding to coefficients

template <class T, class II, class C>
struct row_add_dest {
    typedef C value_type;
    row_add_dest(coefs<T, C> &msc,
                 int oct_, unsigned int obno_):
        oct(oct_), obno(obno_), sc(msc.octaves[oct]),
        sh(sc.ometa->cmeta->slice_len_log2)
    {
        assert(oct < (int) msc.octaves.size());
    }
public:
    II operator()(coef_index_t i0, coef_index_t i1, II input) const {
        assert(i0 <= i1);
        int bsize = 1 << sh;
        coef_index_t i = i0;
        while (i < i1) {
            slice_index_t sli = i >> sh;
            unsigned int bvi = (unsigned int)(i & (bsize - 1));
            unsigned int len = bsize - bvi;
            unsigned int remain = (unsigned int)(i1 - i);
            if (remain < len)
                len = remain;
            int bvie = bvi + len;
            // Begin payload
            oct_coefs<C> *c = get_or_create_ptr(sc, sli);
            C *bv = c->bands[obno];
            for (int j = bvi; j < bvie; j++)
                bv[j] += *input++;
            i += len;
            // End payload
        }
        return input;
    }
    int oct;
    unsigned int obno;
    sliced_coefs<C> &sc;
    unsigned int sh;
};

// Helper for process() below.  Here, the function f() operates on an
// array of consecutive coefficient samples rather than a single
// sample.

template <class T, class F, class C0, class... CI>
void apply_to_slice(bool create,
                    F f,
                    int b0, // = INT_MIN
                    int b1, // = INT_MAX
                    sample_index_t st0, // = INT64_MIN
                    sample_index_t st1, // = INT64_MAX
                    coefs<T, C0>& coefs0,
                    coefs<T, CI>&... coefsi)
{
    set_max(b0, 0);
    set_min(b1, (int) coefs0.cmeta->n_bands_total);
    for (int band = b0; band < b1; band++) {
        int oct;
        unsigned int obno;
        bool valid = gaborator::bno_split(*coefs0.cmeta, band, oct, obno, true);
        assert(valid);

        int exp = band_step_log2(*coefs0.cmeta, band);
        int time_step = 1 << exp;

        coef_index_t ci0 = (st0 + time_step - 1) >> exp;
        coef_index_t ci1 = ((st1 - 1) >> exp) + 1;
        if (! create) {
            // Restrict to existing coefficient index range
            coef_index_t cib0, cib1;
            get_band_coef_bounds(coefs0, oct, obno, cib0, cib1);
            set_max(ci0, cib0);
            set_min(ci1, cib1);
        }
        unsigned int sh = coefs0.cmeta->slice_len_log2;
        sample_index_t st = shift_left(ci0, exp);
        foreach_slice(sh, ci0, ci1,
                      [&](slice_index_t sli, unsigned int bvi,
                          unsigned int len)
        {
            oct_coefs<C0> *c = create ?
                get_or_create_ptr(coefs0.octaves[oct], sli) :
                get_existing_ptr(coefs0.octaves[oct], sli);
            if (c) {
                // p0 points to coefficient from the first set
                C0 *p0 = c->bands[obno] + bvi;
                f(band, st, time_step, len, p0,
                  get_or_create_ptr(coefsi.octaves[oct], sli)->bands[obno] + bvi...);
            }
            st += len * time_step;
        });
    }
}

// Common implementation of process() and fill()

template <class T, class F, class C0, class... CI>
void apply_common(bool create,
                  F f,
                  int b0, // = INT_MIN
                  int b1, // = INT_MAX
                  sample_index_t st0, // = INT64_MIN
                  sample_index_t st1, // = INT64_MAX
                  coefs<T, C0> &coefs0,
                  coefs<T, CI>&... coefsi)
{
    apply_to_slice(create,
                   [&](int bno, int64_t st, int time_step,
                       unsigned len, C0 *p0, CI *...pi)
    {
        for (unsigned int i = 0; i < len; i++) {
            f(bno, st, *p0++, *pi++...);
            st += time_step;
        }
    }, b0, b1, st0, st1, coefs0, coefsi...);
}

// Iterate over one or more coefficient sets in parallel and apply the
// function f, passing it a coefficient from each set as an argument.
//
// The application can be optionally limited to coefficients within
// the band range b0 to b1 and/or the sample time range st0 to st1.
//
// The first coefficient set ("channel 0") is treated specially; it
// determines which coefficients are iterated over (optionally further
// restricted by b0/b1/st0/st1).  That is, the iteration is over the
// coefficients that already exist in channel 0, and no new
// coefficients will be allocated in channel 0.  In the other
// channels, new coefficients will be created on demand when they are
// missing from that channel but present in channel 0.
//
// The coefficients may be of a different data type in each set.
//
// The arguments to f() are:
//
//    int bno        Band number
//    int64_t st     Sample time
//    C &p0          Coefficient from first set
//    C... &pi       Coefficient from subsequent set

template <class T, class F, class C0, class... CI>
void process(F f,
             int b0, // = INT_MIN
             int b1, // = INT_MAX
             sample_index_t t0, // = INT64_MIN
             sample_index_t t1, // = INT64_MAX
             coefs<T, C0> &coefs0,
             coefs<T, CI>&... coefsi)
{
    apply_common(false, f, b0, b1, t0, t1, coefs0, coefsi...);
}

template <class T, class F, class C0, class... CI>
void fill(F f,
          int b0, // = INT_MIN
          int b1, // = INT_MAX
          sample_index_t t0, // = INT64_MIN
          sample_index_t t1, // = INT64_MAX
          coefs<T, C0> &coefs0,
          coefs<T, CI>&... coefsi)
{
    apply_common(true, f, b0, b1, t0, t1, coefs0, coefsi...);
}

// Apply the function f to each existing coefficient in the
// coefficient set msc within the time range st0 to st1.  The
// initial analyzer argument is ignored.
//
// The arguments to f() are:
//
//    C &c           Coefficient
//    int b          Band number
//    int64_t t      Time in samples
//
// This is for backwards compatibility; process() is now preferred.

template <class T, class F>
void apply(const analyzer<T> &, coefs<T> &msc, F f,
           sample_index_t st0 = INT64_MIN,
           sample_index_t st1 = INT64_MAX)
{
    process([&](int b, int64_t t, complex<T>& c) {
            f(c, b, t);
        }, INT_MIN, INT_MAX, st0, st1, msc);
}

// Forget coefficients before a band-specific limit given as a
// function "limitf" of the band number.  Note the use of enable_if to
// avoid matching the template when the limit is independent of the
// band and given as an integer.  std::is_function might have been
// clearer than ! std::is_integral but does not match lambdas, and
// std::is_invocable is in C++17 only.  The return type is void (the
// default type generated by enable_if when matching).
//
// The limit returned by limitf must be non-increasing by band number,
// i.e., the limit for band n+1 must be the same or earlier as that
// for band n, for all valid n.

template <class T, class L>
typename std::enable_if<! std::is_integral<L>::value>::type
forget_before(const analyzer<T> &, coefs<T> &msc, L limitf,
              bool clean_cut = false)
{
    typedef complex<T> C;
    unsigned int n_oct = (unsigned int) msc.octaves.size();
    int slice_len_log2 = msc.cmeta->slice_len_log2;
    unsigned int slice_len = 1 << slice_len_log2;
    for (unsigned int oct = 0; oct < n_oct; oct++) {
        sliced_coefs<C> &sc = msc.octaves[oct];
        // Convert limit from samples to slices, rounding down.
        // This relies on the fact that all bands in the octave
        // have the same time range.
        // First convert samples to coefficients, rounding down
        oct_coefs_meta *ometa = &msc.cmeta->octaves[oct];
        int first_band = ometa->n_bands_above;
        int last_band = ometa->n_bands_above + ometa->n_bands - 1;
        // Because the limit is non-increasing by band, the first
        // band has the latest limit, and the last band has the
        // earliest limit.
        coef_index_t ci0 = limitf(last_band) >> ometa->step_log2;
        coef_index_t ci1 = limitf(first_band) >> ometa->step_log2;
        // Then convert coefficients to slices
        slice_index_t sli0 = ci0 >> slice_len_log2;
        slice_index_t sli1 = (ci1 >> slice_len_log2) + 1;
        sc.slices.erase_before(sli0);
        if (clean_cut) {
            // Partially erase slice(s) at boundary, if any
            for (slice_index_t sli = sli0; sli < sli1; sli++) {
                const auto *t = sc.slices.get(sli);
                if (! t)
                    continue;
                if (! *t)
                    continue;
                const oct_coefs<C> &c = **t;
                unsigned int n_bands = (unsigned int)c.bands.size();
                int time_step = 1 << ometa->step_log2;
                for (unsigned int obno = 0; obno < n_bands; obno++) {
                    C *band = c.bands[obno];
                    unsigned int len = slice_len;
                    sample_index_t st =
                        sample_time(*sc.ometa, sli, 0, oct, obno);
                    int64_t limit = limitf(bno_merge(*msc.cmeta, oct, obno));
                    for (unsigned int i = 0; i < len; i++) {
                        if (st < limit)
                            band[i] = 0;
                        else
                            break;
                        st += time_step;
                    }
                }
            }
        }
    }
}

// Ditto for a limit independent of the band number, given as an integer

template <class T>
void forget_before(const analyzer<T> &anl, coefs<T> &msc,
                   int64_t limit, bool clean_cut = false)
{
    return forget_before(anl, msc, [limit](int){ return limit; }, clean_cut);
}


} // namespace

#endif
