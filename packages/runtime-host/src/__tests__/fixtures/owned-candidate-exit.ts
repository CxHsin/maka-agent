if (process.env.MAKA_TEST_DIAGNOSTIC) {
  process.stderr.write(`${process.env.MAKA_TEST_DIAGNOSTIC}\n`);
}
process.exitCode = Number(process.env.MAKA_TEST_EXIT_CODE ?? 0);
