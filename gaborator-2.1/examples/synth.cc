// See ../doc/synth.html for commentary

#include <memory.h>
#include <iostream>
#include <sndfile.h>
#include <gaborator/gaborator.h>

int main(int argc, char **argv) {
    if (argc < 2) {
        std::cerr << "usage: synth output.wav\n";
        exit(1);
    }
    double fs = 44100;
    gaborator::log_fq_scale scale(12, 20.0 / fs, 8.18 / fs);
    gaborator::parameters params(scale);
    params.phase = gaborator::coef_phase::global;
    gaborator::analyzer<float> analyzer(params);
    static int pentatonic[] = { 57, 60, 62, 64, 67 };
    int n_notes = 64;
    double tempo = 120.0;
    double beat_duration = 60.0 / tempo;
    float volume = 0.2;
    gaborator::coefs<float> coefs(analyzer);
    for (int i = 0; i < n_notes; i++) {
        int midi_note = pentatonic[rand() % 5];
        double note_start_time = beat_duration * i;
        double note_end_time = note_start_time + 3.0;
        int band = analyzer.band_ref() - midi_note;
        fill([&](int, int64_t t, std::complex<float> &coef) {
                float amplitude =
                    volume * expf(-2.0f * (float)(t / fs - note_start_time));
                coef += std::complex<float>(amplitude, 0.0f);
            },
            band, band + 1,
            note_start_time * fs, note_end_time * fs,
            coefs);
    }
    double audio_start_time = -0.5;
    double audio_end_time = beat_duration * n_notes + 5.0;
    int64_t start_frame = audio_start_time * fs;
    int64_t end_frame = audio_end_time * fs;
    size_t n_frames = end_frame - start_frame;
    std::vector<float> audio(n_frames);
    analyzer.synthesize(coefs, start_frame, end_frame, audio.data());
    SF_INFO sfinfo;
    memset(&sfinfo, 0, sizeof(sfinfo));
    sfinfo.samplerate = fs;
    sfinfo.channels = 1;
    sfinfo.format = SF_FORMAT_WAV | SF_FORMAT_PCM_16;
    SNDFILE *sf_out = sf_open(argv[1], SFM_WRITE, &sfinfo);
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
