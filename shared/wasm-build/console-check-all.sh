#!/bin/zsh
# Run console-check across all five games on real maps, aggregate ERRORS/WARNINGS.
cd "$(dirname "$0")/../.."
CC=shared/wasm-build/console-check.mjs
echo "########## RTCW-SP ##########"
node $CC 8790 "+set sv_cheats 1 +set cg_thirdperson 1 +set com_introplayed 1 +devmap escape1" RTCW-SP 95
echo "########## RTCW-MP ##########"
node $CC 8791 "+set sv_cheats 1 +devmap mp_beach" RTCW-MP 95
echo "########## Wolf:ET ##########"
node $CC 8792 "+set sv_cheats 1 +set sv_pure 0 +devmap oasis" Wolf-ET 95
echo "########## JK2 ##########"
node $CC 8793 "+set sv_cheats 1 +devmap demo" JK2 95
echo "########## JKA ##########"
node $CC 8794 "+set sv_cheats 1 +set cg_thirdperson 1 +devmap t1_sour" JKA 95
echo "########## ALL DONE ##########"
