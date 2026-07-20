#ifndef __ICR_STDAFX__
#define __ICR_STDAFX__

#pragma warning( disable : 4786 )  // identifier was truncated 

#pragma warning (push, 3)
#include <string>
#include <list>
#include <vector>
#include <map>
#include <algorithm>
#pragma warning (pop)

#include <string>
#include <vector>
#include <list>
#include <map>
#include <set>
#include <memory>
#include <utility>
using std::string; using std::vector; using std::list; using std::map; using std::multimap; using std::set; using std::multiset; using std::pair; using std::less; using std::allocator; //idTech3-web: narrowed from using-namespace-std

#define STL_ITERATE( a, b )		for ( a = b.begin(); a != b.end(); a++ )
#define STL_INSERT( a, b )		a.insert( a.end(), b );

#endif