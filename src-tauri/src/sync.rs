//! A poisoned mutex only means a panic happened while it was held. The data in
//! it is still whatever was last written, and for settings, pins and caches that
//! is far better than `unwrap()` turning one panic into a panic on every later
//! call for the rest of the session.
use std::sync::{Mutex, MutexGuard};

pub trait LockExt<T> {
    fn lock_or_recover(&self) -> MutexGuard<'_, T>;
}

impl<T> LockExt<T> for Mutex<T> {
    fn lock_or_recover(&self) -> MutexGuard<'_, T> {
        self.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn a_poisoned_mutex_still_hands_out_its_data() {
        let m = std::sync::Arc::new(Mutex::new(5));
        let m2 = m.clone();
        let _ = std::thread::spawn(move || {
            let _g = m2.lock().unwrap();
            panic!("poison it");
        })
        .join();
        assert!(m.is_poisoned());
        *m.lock_or_recover() += 1;
        assert_eq!(*m.lock_or_recover(), 6);
    }
}
