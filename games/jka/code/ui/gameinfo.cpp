//
// gameinfo.c
//

// *** This file is used by both the game and the user interface ***


// ... and for that reason is excluded from PCH usage for the moment =Ste.


#include "gameinfo.h"
#include "..\game\weapons.h"


gameinfo_import_t	gameinfo_gi;	// idTech3-web: renamed from 'gi' (MSVC type-mangling coexisted with game_import_t gi)
#define gi gameinfo_gi

weaponData_t weaponData[WP_NUM_WEAPONS];
ammoData_t ammoData[AMMO_MAX];

extern void WP_LoadWeaponParms (void);

//
// Initialization - Read in files and parse into infos
//

/*
===============
GI_Init
===============
*/
void GI_Init( gameinfo_import_t *import ) {
	gi = *import;

	WP_LoadWeaponParms ();
}
