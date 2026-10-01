# Asset credits

- `assets/characters/ara.glb` and `assets/anims/*.glb`: generated locally by `tools/build_avatar.py`; original geometry and animation data created for this project. No third-party model or texture is embedded.
- `assets/ui/*.svg`: original vector icons created for this project.
- `art/concept/*.png`: generated for this project with OpenAI's built-in image generation tool on 2026-09-25. Used as design references only, not runtime textures.
- Runtime libraries (bundled in `vendor/` so the game runs without internet, 2026-09-26):
  - `vendor/three/`: Three.js r180 (0.180.0) build and 15 example modules, MIT License.
  - `vendor/mediapipe/`: MediaPipe Tasks Vision 0.10.14 bundle and SIMD wasm, Apache License 2.0.
  - `vendor/mediapipe/models/pose_landmarker_{lite,full}.task`: Google MediaPipe Pose Landmarker float16 v1 models, Apache License 2.0.
- `assets/intro/title.jpg`: generated with Higgsfield (GPT Image 2.5) from this project's revised character and arena concepts, 2026-09-25.
- `assets/intro/opening.mp4` and `assets/intro/title-loop.mp4`: generated with Higgsfield (MiniMax H3) from the title image and arena concept, trimmed to remove blurred sections and encoded at 1080p, 2026-09-25.
- `art/concept/revised/*`: costume revisions generated with Higgsfield (GPT Image 2.5), 2026-09-25.
- `assets/characters/ara-hq.glb`: generated with Higgsfield (Meshy) from `art/concept/revised/character-ara-turnaround-v2.png`; runtime texture reduced to 1024×1024 for the 5MB budget, 2026-09-25.
- `assets/anims/meshy/*.json`: Higgsfield (Meshy) animation library Idle, Victory_Cheer, and Catching_Breath motions applied to the Ara model, then reduced to bone-rotation tracks, 2026-09-25.
- `src/game/gwangalli-scene.js`: 광안리 배경(광안대교·마린시티·센텀시티 등)을 코드로 직접 만든 로우폴리 모형, 외부 자료 없음, 2026-09-26.
- `assets/ui/portraits/*.webp`: `art/3d/*/front.png`(프로젝트 캐릭터 3면도)에서 얼굴 부분을 잘라 만듦(Claude), 2026-09-26.
- `assets/ui/menu/*.webp`, `art/menu/*.png`: Google Gemini(Nano Banana Pro)로 인트로 그림과 캐릭터 3면도를 참고해 생성, 2026-09-27(Claude)
- `assets/ui/crowd-atlas.webp`(피켓 판), `art/crowd/fans-a-sign3.png`, `art/crowd/fans-b-sign.png`: Google Gemini(Nano Banana Pro)로 기존 관객 그림을 고쳐 생성, 2026-09-27(Claude)
- `assets/ui/busan-boards.webp`: OpenAI 내장 이미지 생성 도구로 만든 광고판 시안 `art/concept/revised/busan-board-backgrounds-v1.png`의 8칸을 테두리 없이 잘라 다시 묶음, 2026-09-28(GPT 디자인, Claude 런타임 변환)
- `assets/ui/busan-icons.webp`, `art/busan/busan-icons.png`: 부산 명소·음식 그림 8개, Google Gemini(Nano Banana Pro)로 생성, 2026-09-27(Claude, 더 이상 게임에서 쓰지 않음)

No Kinect Sports screenshots, models, textures, or audio are distributed with this project.
