//
// Intrusive reference counting smart pointer
//
// Copyright (C) 2016-2023 Andreas Gustafsson.  This file is part of
// the Gaborator library source distribution.  See the file LICENSE at
// the top level of the distribution for license information.
//

#ifndef _GABORATOR_REF_H
#define _GABORATOR_REF_H

namespace gaborator {

template <class T> struct ref;

struct refcounted {
    refcounted(): refcount(0) { }
    unsigned int refcount;
protected:
    ~refcounted() { }
};

// Template functions for manual reference counting, without using the
// ref<> class.  It would be tempting to make these methods of struct
// refcounted, but that won't work because it would lose the full
// object type and invoke operator delete on the base class.

template <class T>
void incref(T *r) {
    r->refcount++;
}

template <class T>
void decref(T *r) {
    r->refcount--;
    if (r->refcount == 0)
        delete r;
}

template <class T>
struct ref {
    typedef T element_type;
    ref(): p(0) { }
    ref(T *p_): p(p_) {
        _incref();
    }
    ref(const ref &o): p(o.p) {
        _incref();
    }
    // Move constructor
    ref(ref &&o) {
        p = o.p;
        o.p = 0;
    }
    ref &operator=(const ref &o) {
        reset(o.p);
        return *this;
    }
    ~ref() { reset(); }
    void reset() {
        _decref();
        p = 0;
    }
    void reset(T *n) {
        if (n == p)
            return;
        _decref();
        p = n;
        _incref();
    }
    T *get() const { return p; }
    T *operator->() const { return p; }
    T &operator*() const { return *p; }
    operator bool() const { return p; }
private:
    void _incref() {
        if (! p)
            return;
        incref(p);
    }
    void _decref() {
        if (! p)
            return;
        decref(p);
    }
    T *p;
};

} // namespace

#endif
