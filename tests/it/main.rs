//! Integration tests: one binary, one module per area.
//!
//! A test belongs here, not next to the code, when it starts another program (the stand-ins in `tarsee-testbin`),
//! or drives the whole server. Everything else is a unit test in the module it tests.

mod support;

mod foundation;
