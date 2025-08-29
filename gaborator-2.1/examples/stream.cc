// See ../doc/stream.html for commentary

#include <memory.h>
#include <iostream>
#include <sndfile.h>
#include <gaborator/gaborator.h>

int main(int argc, char **argv) {
    if (argc < 3) {
        std::cerr << "usage: stream input.wav output.wav\n";
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
    if (sfinfo.channels != 1) {
        std::cerr << "only mono files are supported\n";
        exit(1);
    }
    double fs = sfinfo.samplerate;

    SNDFILE *sf_out = sf_open(argv[2], SFM_WRITE, &sfinfo);
    if (! sf_out) {
        std::cerr << "could not open output audio file: "
            << sf_strerror(sf_out) << "\n";
        exit(1);
    }
    sf_command(sf_in, SFC_SET_NORM_FLOAT, NULL, SF_FALSE);
    sf_command(sf_out, SFC_SET_NORM_FLOAT, NULL, SF_FALSE);
    gaborator::log_fq_scale scale(12, 200.0 / fs, 440.0 / fs);
    gaborator::parameters params(scale);
    gaborator::analyzer<float> analyzer(params);
    size_t analysis_support = ceil(analyzer.analysis_support());
    size_t synthesis_support = ceil(analyzer.synthesis_support());
    std::cerr << "latency: " << analysis_support + synthesis_support << " samples\n";
    gaborator::coefs<float> coefs(analyzer);
    const size_t blocksize = 1024;
    std::vector<float> buf(blocksize);
    int64_t t_in = 0;
    for (;;) {
        sf_count_t n_read = sf_readf_float(sf_in, buf.data(), blocksize);
        if (n_read == 0)
            break;
        if (n_read < blocksize)
            std::fill(buf.data() + n_read, buf.data() + blocksize, 0);
        analyzer.analyze(buf.data(), t_in, t_in + blocksize, coefs);
        process(
            [&](int, int64_t, std::complex<float> &coef) {
                 coef = -coef;
            },
            INT_MIN, INT_MAX,
            t_in - (int)analysis_support,
            t_in - (int)analysis_support + (int)blocksize,
            coefs);
        int64_t t_out = t_in - analysis_support - synthesis_support;
        analyzer.synthesize(coefs, t_out, t_out + blocksize, buf.data());
        sf_count_t n_written = sf_writef_float(sf_out, buf.data(), blocksize);
        if (n_written != blocksize) {
            std::cerr << "write error\n";
            exit(1);
        }
        forget_before(analyzer, coefs, t_out + blocksize - synthesis_support);
        t_in += blocksize;
    }
    sf_close(sf_in);
    sf_close(sf_out);
    return 0;
}
