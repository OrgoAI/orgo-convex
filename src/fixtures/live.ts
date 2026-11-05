// Guest responses captured from a real Orgo Linux computer with
// POST /api/computers/{id}/bash|exec. Frozen here so tests read real shapes.
// timeout: the `timeout` sent; the run lasted about that long.

/** bash-exit2-stderr */
export const bashExit2Stderr = {
  success: true,
  action: "bash",
  command: "echo out; echo err 1>&2; exit 2",
  output: "out\n\nerr\n",
  exit_code: 2,
  error: null,
  error_type: null,
};

/** bash-ok */
export const bashOk = {
  success: true,
  action: "bash",
  command: "echo hello",
  output: "hello\n",
  exit_code: 0,
  error: null,
  error_type: null,
};

/** bash-timeout */
export const bashTimeout2s = {
  success: true,
  action: "bash",
  command: "sleep 30",
  output: "",
  exit_code: -1,
  error: null,
  error_type: null,
};

/** exec-ok */
export const execOk = {
  success: true,
  action: "exec",
  output: "42\n",
  timeout: false,
  error: null,
  error_type: null,
};

/** exec-raise */
export const execRaise = {
  success: false,
  action: "exec",
  output:
    'Traceback (most recent call last):\n  File "<string>", line 1, in <module>\nValueError: boom\n',
  timeout: false,
  error: null,
  error_type: null,
};

/** exec-timeout */
export const execTimeout2s = {
  success: false,
  action: "exec",
  output: "",
  timeout: false,
  error: null,
  error_type: null,
};
