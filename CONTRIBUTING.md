# Contributing

Bug reports are the most useful thing you can send. Open an issue with what
you were doing, which browser, and the console output with **Settings →
About → Say what it is doing in the console** switched on. That log names
every step Torval took, which is usually enough to find the fault without
guessing.

Patches are welcome too. Keep them small and to one subject, and run
`node tools/test.mjs` before sending.

## Copyright

Torval is Copyright © 2026 Jacob Gerritz, and is released under GPL-3.0.

By sending a contribution you agree to two things. The first is that it is
your own work and you have the right to give it. The second is that, as well
as releasing it under GPL-3.0 along with the rest of the project, you grant
Jacob Gerritz a perpetual, worldwide, irrevocable, royalty-free right to use
it, including under different licence terms.

That second part is there so the licence can still be changed later without
having to find and ask everyone who ever sent a patch. Projects that skip it
usually find out too late that they cannot. It does not take anything away
from you: your contribution stays under GPL-3.0 in every released version,
and you keep the copyright in your own work.

## What can come into the codebase

Two rules, both about keeping the licence something that can still be
decided later.

**No dependencies.** Torval has no package.json and no npm packages, and
the test suite fails if one appears. Everything it needs, it has. A
dependency under a copyleft licence would settle the licensing question
permanently, and one under any licence is a thing that can be abandoned,
compromised or rewritten out from under a project that trusted it.

**No code copied from elsewhere.** Not a function, not a regular
expression somebody else worked out. Code taken from a GPL project would
mean Torval could never be licensed any other way, whatever the grant
above says, because that other author never agreed to it. If something
elsewhere solves a problem, read it, understand it, and write it here.

Dictionary data is a separate matter and comes from other people by
design. It stays data, in `extension/data*/`, under its own CC BY-SA
licence, and is never turned into source code.
