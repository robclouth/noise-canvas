// See ../doc/snr.html for commentary

#include <iostream>
#include <iomanip>
#include <random>
#include <gaborator/gaborator.h>
double rms(const std::vector<float> &v) {
    double sqsum = 0;
    for (size_t i = 0; i < v.size(); i++) {
        sqsum += v[i] * v[i];
    }
    return sqrt(sqsum);
}
int main(int argc, char **argv) {
    size_t len = 1000000;
    std::vector<float> signal_in(len);
    std::minstd_rand rand;
    std::uniform_real_distribution<> uniform(-1.0, 1.0);
    for (size_t i = 0; i < len; i++)
        signal_in[i] = uniform(rand);
    gaborator::parameters params(gaborator::log_fq_scale(48, 5e-4));
    gaborator::analyzer<float> analyzer(params);
    gaborator::coefs<float> coefs(analyzer);
    analyzer.analyze(signal_in.data(), 0, len, coefs);
    std::vector<float> signal_out(len);
    analyzer.synthesize(coefs, 0, len, signal_out.data());
    std::vector<float> error(len);
    for (size_t i = 0; i < len; i++)
         error[i] = signal_out[i] - signal_in[i];
    double snr = rms(signal_in) / rms(error);
    std::cout << std::fixed << std::setprecision(1) << 20 * log10(snr) << " dB\n";
}
