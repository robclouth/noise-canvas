//
// Pool of shared objects
//
// Copyright (C) 2015-2022 Andreas Gustafsson.  This file is part of
// the Gaborator library source distribution.  See the file LICENSE at
// the top level of the distribution for license information.
//

#ifndef _GABORATOR_POOL_H
#define _GABORATOR_POOL_H

#include <map>

namespace gaborator {

// The "pool" class is for sharing FFT objects so that we don't
// create multiple FFTs of the same size.  It could also be used
// to share objects of some other class T where we wish to avoid
// creating multiple Ts with the same K.

template <class T, class K>
struct pool {
    typedef std::map<K, T *> m_t;
    ~pool() {
        for (typename m_t::iterator it = m.begin(); it != m.end(); it++) {
            delete (*it).second;
        }
    }
    T *get(const K &k) {
        std::pair<typename m_t::iterator, bool> r =
            m.insert(std::make_pair(k, (T *)0));
        if (r.second) {
            // New element was inserted
            assert((*(r.first)).second == 0);
            (*r.first).second = new T(k);
        }
        return (*r.first).second;
    }
    m_t m;
};

} // namespace

#endif
