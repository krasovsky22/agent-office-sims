# Third-party notices

This repository includes material from the projects below. Each notice is
reproduced as its licence requires.

## agent-office

The agent runner (`apps/runner`) follows the design of agent-office, and code
adapted from it is distributed under the MIT License below.

- Project: <https://github.com/AgentSystemLabs/agent-office>
- Licence: MIT

```
MIT License

Copyright (c) 2026 AgentSystemLabs

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### Marking adapted files

Every file that contains code adapted from agent-office says so in its first
line, above the file's doc comment, naming the file it came from:

```ts
// Adapted from agent-office (MIT, Copyright (c) 2026 AgentSystemLabs): src/server/<file>.ts. See THIRD_PARTY_NOTICES.md.
```

A file written from scratch carries no such line, even where it follows
agent-office's design. Removing the last adapted code from a file removes its
line.

## Office prop kit

The vendored models in `apps/client/src/assets/office-kit/` are Kenney's
Furniture Kit, CC0 1.0; that directory's `README.md` is their licence record.
