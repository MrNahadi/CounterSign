# Progress: phase 4, tamper-evident audit log (specs/features/04-tamper-evident-audit-log)

## T-001
IdSchema now rejects lone surrogates (isWellFormed refine), so mandate, case file and proposal parsers deny them and decide never throws in hashIntent.
Gotcha: build lone-surrogate strings in tests with String.fromCharCode(0xd800); `\u` escapes get decoded by the Write tool.
