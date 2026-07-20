// Filename:-	stringed_interface.h
//
// These are the functions that get replaced by game-specific ones (or StringEd code) so SGE can access files etc
//

#ifndef STRINGED_INTERFACE_H
#define STRINGED_INTERFACE_H

#pragma warning ( disable : 4786 )			// disable the usual stupid and pointless STL warning
#include <string>
#include <string>
#include <vector>
#include <list>
#include <map>
#include <set>
#include <memory>
#include <utility>
using std::string; using std::vector; using std::list; using std::map; using std::multimap; using std::set; using std::multiset; using std::pair; using std::less; using std::allocator; //idTech3-web: narrowed from using-namespace-std

unsigned char *	SE_LoadFileData			( const char *psFileName, int *piLoadedLength = 0);
void			SE_FreeFileDataAfterLoad( unsigned char *psLoadedFile );
int				SE_BuildFileList		( const char *psStartDir, string &strResults );

#endif	// #ifndef STRINGED_INTERFACE_H


////////////////// eof ///////////////////

