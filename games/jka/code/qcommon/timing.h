
class timing_c
{
private:
	__int64	start;
	__int64	end;

	int		reset;
public:
	timing_c(void)
	{
	}
	void Start()
	{
		const __int64 *s = &start;
#if defined( __EMSCRIPTEN__ )   // idTech3-web: no x86 rdtsc; profiling timer disabled
		start = 0; (void)s;
#else
		__asm
		{
			push eax
			push ebx
			push edx

			rdtsc
			mov ebx, s
			mov	[ebx], eax
			mov [ebx + 4], edx

			pop edx
			pop ebx
			pop eax
		}
#endif
	}
	int End()
	{
		const __int64 *e = &end;
		__int64	time;
#if defined( __EMSCRIPTEN__ )
		end = 0; (void)e;
#else
		__asm
		{
			push eax
			push ebx
			push edx

			rdtsc
			mov ebx, e
			mov	[ebx], eax
			mov [ebx + 4], edx

			pop edx
			pop ebx
			pop eax
		}
#endif
		time = end - start;
		if (time < 0)
		{
			time = 0;
		}
		return((int)time);
	}
};

// end