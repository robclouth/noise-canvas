// See ../doc/render.html for commentary

#include <memory.h>
#include <iostream>
#include <fstream>
#include <sndfile.h>
#include <gaborator/gaborator.h>
#include <gaborator/render.h>
int main(int argc, char **argv) {
    if (argc < 3) {
        std::cerr << "usage: render input.wav output.pgm\n";
        exit(1);
    }
    SF_INFO sfinfo;
    memset(&sfinfo, 0, sizeof(sfinfo));
    SNDFILE *sf_in = sf_open(argv[1], SFM_READ, &sfinfo);
    if (! sf_in) {
        std::cerr << "could not open input audio file: "
            << sf_strerror(sf_in) << "\n";
        exit(1);
    }
    double fs = sfinfo.samplerate;
    sf_count_t n_frames = sfinfo.frames;
    sf_count_t n_samples = sfinfo.frames * sfinfo.channels;
    std::vector<float> audio(n_samples);
    sf_count_t n_read = sf_readf_float(sf_in, audio.data(), n_frames);
    if (n_read != n_frames) {
        std::cerr << "read error\n";
        exit(1);
    }
    sf_close(sf_in);
    std::vector<float> mono(n_frames);
    for (size_t i = 0; i < (size_t)n_frames; i++) {
        float v = 0;
        for (size_t c = 0; c < (size_t)sfinfo.channels; c++)
            v += audio[i * sfinfo.channels + c];
        mono[i] = v;
    }
    gaborator::log_fq_scale scale(48, 20.0 / fs, 440.0 / fs);
    gaborator::parameters params(scale);
    gaborator::analyzer<float> analyzer(params);
    gaborator::coefs<float> coefs(analyzer);
    analyzer.analyze(mono.data(), 0, mono.size(), coefs);
    int64_t x_origin = 0;
    int64_t y_origin = analyzer.bandpass_bands_begin();
    int x_scale_exp = 10;
    while ((n_frames >> x_scale_exp) > 1000)
        x_scale_exp++;
    int y_scale_exp = 0;
    int64_t x0 = 0;
    int64_t y0 = 0;
    int64_t x1 = n_frames >> x_scale_exp;
    int64_t y1 = (analyzer.bandpass_bands_end() - analyzer.bandpass_bands_begin()) >> y_scale_exp;
    std::vector<float> amplitudes((x1 - x0) * (y1 - y0));
    gaborator::render_p2scale(
        analyzer,
        coefs,
        x_origin, y_origin,
        x0, x1, x_scale_exp,
        y0, y1, y_scale_exp,
        amplitudes.data());
    float gain = 15;
    std::ofstream f;
    f.open(argv[2], std::ios::out | std::ios::binary);
    f << "P5\n" << (x1 - x0) << ' ' << (y1 - y0) << "\n255\n";
    for (size_t i = 0; i < amplitudes.size(); i++)
        f.put(gaborator::float2pixel_8bit(amplitudes[i] * gain));
    f.close();
    return 0;
}
