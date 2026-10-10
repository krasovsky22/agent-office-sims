# Avatar model

`RobotExpressive.glb` is the rigged humanoid every occupant is drawn as.

- **Model:** RobotExpressive, by [Tomás Laulhé](https://www.patreon.com/quaternius)
  (Quaternius).
- **Licence:** [CC0 1.0 Universal](https://creativecommons.org/publicdomain/zero/1.0/) —
  public domain dedication. No attribution is required; this file records the
  provenance anyway so the next person does not have to go looking for it.
- **Modifications by** [Don McCurdy](https://donmccurdy.com/): three facial
  expression morph targets added, converted with FBX2GLTF, duplicate materials
  removed and material metalness reduced.
- **Obtained from** the three.js repository, which carries the same licence
  statement for it:
  <https://github.com/mrdoob/three.js/tree/dev/examples/models/gltf/RobotExpressive>
- **SHA-256:** `047f5e5fb3bb6d378bd1df16ca6137f2a596c99b3a1b5690b4020c05aaf6f319`

The asset ships unmodified. Everything the renderer needs beyond what is in the
file is derived at load time by `src/scene/avatarClips.ts`, which is also where
the two facts about this particular asset live: the clip names it carries, and
the bone names the derived typing clip drives.

## Why this one

The avatar needs idle, walk, sit and type clips under a permissive licence.
Quaternius was the expected source and this is the Quaternius character whose
licence is stated at the point of download rather than implied, which matters
more than the stylisation: it is a cartoon robot rather than a person, and it
suits an office staffed by agents. Mixamo's humans were the other candidate, but
its downloads are behind an account and the licence attaches to the account
holder rather than to the file, so a committed copy could not record its own
terms.

The asset has no typing clip — few free packs do. `avatarClips.ts` derives one
from the seated pose, which is why the sit clip is a hard requirement of the
asset and the type clip is not.
