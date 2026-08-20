jka-web
=======

A browser / WebAssembly port of the single-player engine of Star Wars Jedi Knight: Jedi Academy, built from Raven Software's original GPL source release.


COPYRIGHT AND LICENCE
---------------------

The engine sources under games/jka/ are:

    Copyright (C) 2003 Activision / Raven Software
    Released by the copyright holder under the GNU General Public License, version 2.

    The drop ships the GNU GPL version 2 as games/jka/LICENSE.txt.

The port (everything outside games/jka/ -- the Emscripten platform layer under
shared/wasm-build/sys_emscripten*/, the build scripts, the browser shell under play/,
the test harnesses, and the optional cloud backend) is likewise distributed under the
GNU General Public License, version 2. See LICENSE for the full text.

GPLv2, not GPLv3: the drop grants version 2 and does not include the customary "or (at
your option) any later version" clause for Raven's own code, so the combined work can
only be distributed under version 2. The only files in the drop carrying an "any later
version" grant are third-party components (the OpenAL headers and the mp3 decoder),
which does not extend to the engine as a whole.


GAME DATA IS NOT INCLUDED
-------------------------

No Jedi Academy game assets are contained in, or distributed by, this repository. The
retail archives (assets0.pk3 and friends) are commercial content and are not
redistributable. To play you must supply your own legally-obtained copy, There is no freely-redistributable demo
mission for Jedi Academy.

The .gitignore is written so that game data cannot be committed by accident, and the
published history has been checked to confirm none ever was.


TRADEMARKS
----------

STAR WARS and JEDI KNIGHT are trademarks of Lucasfilm Ltd. and/or its affiliates.
JEDI ACADEMY is a trademark of its respective owner. Activision and Raven Software are
trademarks of their respective owners. OpenAL and EAX are trademarks of Creative
Technology Ltd. SmartHeap is a trademark of MicroQuill Software Publishing, Inc. Bink
Video is a trademark of RAD Game Tools, Inc.

This project is not affiliated with, endorsed by, or sponsored by any of them. The
names are used only to identify the software this port is derived from and the
components the original sources referenced.


THIRD-PARTY COMPONENTS
----------------------

See `THIRD-PARTY-LICENSES.md` for the components bundled in the original drop, their
licences, and which of them this port actually compiles.

Proprietary pre-compiled binaries that shipped inside the original drop (SmartHeap,
OpenAL, EAX, Immersion FeelIt and Bink Video .dll/.lib files) have been removed from
this repository. They are not GPL-licensed, are not required to build the WebAssembly
port, and redistributing them is not something the GPL grant covers. See
THIRD-PARTY-LICENSES.md for the complete list of what was removed.
