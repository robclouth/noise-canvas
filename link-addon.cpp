#include <napi.h>
#include <ableton/Link.hpp>
#include <memory>
#include <mutex>

static std::unique_ptr<ableton::Link> gLink;
static Napi::ThreadSafeFunction gTempoTsfn;
static Napi::ThreadSafeFunction gStartStopTsfn;
static Napi::ThreadSafeFunction gNumPeersTsfn;
static bool gCallbacksRegistered = false;

Napi::Value Create(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsNumber()) {
    Napi::TypeError::New(env, "Expected bpm (number)").ThrowAsJavaScriptException();
    return env.Undefined();
  }

  double bpm = info[0].As<Napi::Number>().DoubleValue();
  gLink = std::make_unique<ableton::Link>(bpm);

  gLink->setTempoCallback([](double tempo) {
    if (gCallbacksRegistered) {
      double* data = new double(tempo);
      gTempoTsfn.NonBlockingCall(data, [](Napi::Env env, Napi::Function fn, double* tempo) {
        fn.Call({Napi::Number::New(env, *tempo)});
        delete tempo;
      });
    }
  });

  gLink->setStartStopCallback([](bool isPlaying) {
    if (gCallbacksRegistered) {
      bool* data = new bool(isPlaying);
      gStartStopTsfn.NonBlockingCall(data, [](Napi::Env env, Napi::Function fn, bool* isPlaying) {
        fn.Call({Napi::Boolean::New(env, *isPlaying)});
        delete isPlaying;
      });
    }
  });

  gLink->setNumPeersCallback([](std::size_t numPeers) {
    if (gCallbacksRegistered) {
      std::size_t* data = new std::size_t(numPeers);
      gNumPeersTsfn.NonBlockingCall(data, [](Napi::Env env, Napi::Function fn, std::size_t* numPeers) {
        fn.Call({Napi::Number::New(env, static_cast<double>(*numPeers))});
        delete numPeers;
      });
    }
  });

  return env.Undefined();
}

Napi::Value SetCallbacks(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsObject()) {
    Napi::TypeError::New(env, "Expected callbacks object").ThrowAsJavaScriptException();
    return env.Undefined();
  }

  Napi::Object callbacks = info[0].As<Napi::Object>();

  if (gCallbacksRegistered) {
    gTempoTsfn.Release();
    gStartStopTsfn.Release();
    gNumPeersTsfn.Release();
    gCallbacksRegistered = false;
  }

  Napi::Function onTempo = callbacks.Get("onTempoChanged").As<Napi::Function>();
  Napi::Function onStartStop = callbacks.Get("onStartStopChanged").As<Napi::Function>();
  Napi::Function onNumPeers = callbacks.Get("onNumPeersChanged").As<Napi::Function>();

  gTempoTsfn = Napi::ThreadSafeFunction::New(
    env, onTempo, "LinkTempoCallback", 0, 1);
  gStartStopTsfn = Napi::ThreadSafeFunction::New(
    env, onStartStop, "LinkStartStopCallback", 0, 1);
  gNumPeersTsfn = Napi::ThreadSafeFunction::New(
    env, onNumPeers, "LinkNumPeersCallback", 0, 1);

  gCallbacksRegistered = true;
  return env.Undefined();
}

Napi::Value Destroy(const Napi::CallbackInfo& info) {
  if (gCallbacksRegistered) {
    gTempoTsfn.Release();
    gStartStopTsfn.Release();
    gNumPeersTsfn.Release();
    gCallbacksRegistered = false;
  }
  gLink.reset();
  return info.Env().Undefined();
}

Napi::Value Enable(const Napi::CallbackInfo& info) {
  if (gLink) gLink->enable(true);
  return info.Env().Undefined();
}

Napi::Value Disable(const Napi::CallbackInfo& info) {
  if (gLink) gLink->enable(false);
  return info.Env().Undefined();
}

Napi::Value IsEnabled(const Napi::CallbackInfo& info) {
  return Napi::Boolean::New(info.Env(), gLink ? gLink->isEnabled() : false);
}

Napi::Value EnableStartStopSync(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsBoolean()) {
    Napi::TypeError::New(env, "Expected boolean").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  if (gLink) gLink->enableStartStopSync(info[0].As<Napi::Boolean>().Value());
  return env.Undefined();
}

Napi::Value SetIsPlaying(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!gLink || info.Length() < 1 || !info[0].IsBoolean()) {
    return env.Undefined();
  }

  bool isPlaying = info[0].As<Napi::Boolean>().Value();
  auto state = gLink->captureAppSessionState();
  state.setIsPlaying(isPlaying, gLink->clock().micros());
  gLink->commitAppSessionState(state);
  return env.Undefined();
}

Napi::Value SetTempo(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!gLink || info.Length() < 1 || !info[0].IsNumber()) {
    return env.Undefined();
  }

  double bpm = info[0].As<Napi::Number>().DoubleValue();
  auto state = gLink->captureAppSessionState();
  state.setTempo(bpm, gLink->clock().micros());
  gLink->commitAppSessionState(state);
  return env.Undefined();
}

Napi::Value RequestBeatAtTime(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!gLink || info.Length() < 2 || !info[0].IsNumber() || !info[1].IsNumber()) {
    return env.Undefined();
  }

  double beat = info[0].As<Napi::Number>().DoubleValue();
  double quantum = info[1].As<Napi::Number>().DoubleValue();
  auto state = gLink->captureAppSessionState();
  state.requestBeatAtTime(beat, gLink->clock().micros(), quantum);
  gLink->commitAppSessionState(state);
  return env.Undefined();
}

Napi::Value CaptureState(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!gLink) {
    return env.Undefined();
  }

  double quantum = 4.0;
  if (info.Length() >= 1 && info[0].IsNumber()) {
    quantum = info[0].As<Napi::Number>().DoubleValue();
  }

  auto state = gLink->captureAppSessionState();
  auto time = gLink->clock().micros();

  Napi::Object result = Napi::Object::New(env);
  result.Set("tempo", Napi::Number::New(env, state.tempo()));
  result.Set("beat", Napi::Number::New(env, state.beatAtTime(time, quantum)));
  result.Set("phase", Napi::Number::New(env, state.phaseAtTime(time, quantum)));
  result.Set("isPlaying", Napi::Boolean::New(env, state.isPlaying()));
  result.Set("numPeers", Napi::Number::New(env, static_cast<double>(gLink->numPeers())));

  return result;
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("create", Napi::Function::New(env, Create));
  exports.Set("destroy", Napi::Function::New(env, Destroy));
  exports.Set("setCallbacks", Napi::Function::New(env, SetCallbacks));
  exports.Set("enable", Napi::Function::New(env, Enable));
  exports.Set("disable", Napi::Function::New(env, Disable));
  exports.Set("isEnabled", Napi::Function::New(env, IsEnabled));
  exports.Set("enableStartStopSync", Napi::Function::New(env, EnableStartStopSync));
  exports.Set("setIsPlaying", Napi::Function::New(env, SetIsPlaying));
  exports.Set("setTempo", Napi::Function::New(env, SetTempo));
  exports.Set("requestBeatAtTime", Napi::Function::New(env, RequestBeatAtTime));
  exports.Set("captureState", Napi::Function::New(env, CaptureState));
  return exports;
}

NODE_API_MODULE(link_addon, Init)
