// See ../doc/filter.html for commentary

#include <memory.h>
#include <iostream>
#include <sndfile.h>
#include <gaborator/gaborator.h>

int main(int argc, char **argv) {
    if (argc < 3) {
        std::cerr << "usage: filter input.wav output.wav\n";
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
    gaborator::log_fq_scale scale(10, 20.0 / fs);
    gaborator::parameters params(scale);
    gaborator::analyzer<float> analyzer(params);
    std::vector<float> band_gains(analyzer.bands_end());
    for (int band = analyzer.bandpass_bands_begin(); band < analyzer.bandpass_bands_end(); band++) {
        double f_hz = analyzer.band_ff(band) * fs;
        band_gains[band] = 1.0 / sqrt(f_hz / 20.0);
    }
    band_gains[analyzer.band_lowpass()] = band_gains[analyzer.bandpass_bands_end() - 1];
    for (sf_count_t ch = 0; ch < sfinfo.channels; ch++) {
        std::vector<float> channel(n_frames);
        for (sf_count_t i = 0; i < n_frames; i++)
            channel[i] = audio[i * sfinfo.channels + ch];
        gaborator::coefs<float> coefs(analyzer);
        analyzer.analyze(channel.data(), 0, channel.size(), coefs);
        process([&](int band, int64_t, std::complex<float> &coef) {
                coef *= band_gains[band];
            },
            INT_MIN, INT_MAX,
            INT64_MIN, INT64_MAX,
            coefs);
        analyzer.synthesize(coefs, 0, channel.size(), channel.data());
        for (sf_count_t i = 0; i < n_frames; i++)
            audio[i * sfinfo.channels + ch] = channel[i];
    }
    SNDFILE *sf_out = sf_open(argv[2], SFM_WRITE, &sfinfo);
    if (! sf_out) {
        std::cerr << "could not open output audio file: "
            << sf_strerror(sf_out) << "\n";
        exit(1);
    }
    sf_command(sf_out, SFC_SET_CLIPPING, NULL, SF_TRUE);
    sf_count_t n_written = sf_writef_float(sf_out, audio.data(), n_frames);
    if (n_written != n_frames) {
        std::cerr << "write error\n";
        exit(1);
    }
    sf_close(sf_out);
    return 0;
}
