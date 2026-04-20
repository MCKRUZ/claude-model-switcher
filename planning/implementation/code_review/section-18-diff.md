diff --git a/package-lock.json b/package-lock.json
index bc0a162..23632a4 100644
--- a/package-lock.json
+++ b/package-lock.json
@@ -24,10 +24,16 @@
         "@types/eslint": "^8.56.12",
         "@types/js-yaml": "^4.0.9",
         "@types/node": "^20.14.12",
+        "@types/react": "^18.3.3",
+        "@types/react-dom": "^18.3.0",
         "@typescript-eslint/eslint-plugin": "^7.17.0",
         "@typescript-eslint/parser": "^7.17.0",
         "@vitest/coverage-v8": "^1.6.0",
         "eslint": "^8.57.0",
+        "jsdom": "^24.1.1",
+        "react": "^18.3.1",
+        "react-dom": "^18.3.1",
+        "recharts": "^2.12.7",
         "typescript": "^5.5.4",
         "vitest": "^1.6.0"
       },
@@ -49,6 +55,20 @@
         "node": ">=6.0.0"
       }
     },
+    "node_modules/@asamuzakjp/css-color": {
+      "version": "3.2.0",
+      "resolved": "https://registry.npmjs.org/@asamuzakjp/css-color/-/css-color-3.2.0.tgz",
+      "integrity": "sha512-K1A6z8tS3XsmCMM86xoWdn7Fkdn9m6RSVtocUrJYIwZnFVkng/PvkEoWtOWmP+Scc6saYWHWZYbndEEXxl24jw==",
+      "dev": true,
+      "license": "MIT",
+      "dependencies": {
+        "@csstools/css-calc": "^2.1.3",
+        "@csstools/css-color-parser": "^3.0.9",
+        "@csstools/css-parser-algorithms": "^3.0.4",
+        "@csstools/css-tokenizer": "^3.0.3",
+        "lru-cache": "^10.4.3"
+      }
+    },
     "node_modules/@babel/helper-string-parser": {
       "version": "7.27.1",
       "resolved": "https://registry.npmjs.org/@babel/helper-string-parser/-/helper-string-parser-7.27.1.tgz",
@@ -85,6 +105,16 @@
         "node": ">=6.0.0"
       }
     },
+    "node_modules/@babel/runtime": {
+      "version": "7.29.2",
+      "resolved": "https://registry.npmjs.org/@babel/runtime/-/runtime-7.29.2.tgz",
+      "integrity": "sha512-JiDShH45zKHWyGe4ZNVRrCjBz8Nh9TMmZG1kh4QTK8hCBTWBi8Da+i7s1fJw7/lYpM4ccepSNfqzZ/QvABBi5g==",
+      "dev": true,
+      "license": "MIT",
+      "engines": {
+        "node": ">=6.9.0"
+      }
+    },
     "node_modules/@babel/types": {
       "version": "7.29.0",
       "resolved": "https://registry.npmjs.org/@babel/types/-/types-7.29.0.tgz",
@@ -106,6 +136,121 @@
       "dev": true,
       "license": "MIT"
     },
+    "node_modules/@csstools/color-helpers": {
+      "version": "5.1.0",
+      "resolved": "https://registry.npmjs.org/@csstools/color-helpers/-/color-helpers-5.1.0.tgz",
+      "integrity": "sha512-S11EXWJyy0Mz5SYvRmY8nJYTFFd1LCNV+7cXyAgQtOOuzb4EsgfqDufL+9esx72/eLhsRdGZwaldu/h+E4t4BA==",
+      "dev": true,
+      "funding": [
+        {
+          "type": "github",
+          "url": "https://github.com/sponsors/csstools"
+        },
+        {
+          "type": "opencollective",
+          "url": "https://opencollective.com/csstools"
+        }
+      ],
+      "license": "MIT-0",
+      "engines": {
+        "node": ">=18"
+      }
+    },
+    "node_modules/@csstools/css-calc": {
+      "version": "2.1.4",
+      "resolved": "https://registry.npmjs.org/@csstools/css-calc/-/css-calc-2.1.4.tgz",
+      "integrity": "sha512-3N8oaj+0juUw/1H3YwmDDJXCgTB1gKU6Hc/bB502u9zR0q2vd786XJH9QfrKIEgFlZmhZiq6epXl4rHqhzsIgQ==",
+      "dev": true,
+      "funding": [
+        {
+          "type": "github",
+          "url": "https://github.com/sponsors/csstools"
+        },
+        {
+          "type": "opencollective",
+          "url": "https://opencollective.com/csstools"
+        }
+      ],
+      "license": "MIT",
+      "engines": {
+        "node": ">=18"
+      },
+      "peerDependencies": {
+        "@csstools/css-parser-algorithms": "^3.0.5",
+        "@csstools/css-tokenizer": "^3.0.4"
+      }
+    },
+    "node_modules/@csstools/css-color-parser": {
+      "version": "3.1.0",
+      "resolved": "https://registry.npmjs.org/@csstools/css-color-parser/-/css-color-parser-3.1.0.tgz",
+      "integrity": "sha512-nbtKwh3a6xNVIp/VRuXV64yTKnb1IjTAEEh3irzS+HkKjAOYLTGNb9pmVNntZ8iVBHcWDA2Dof0QtPgFI1BaTA==",
+      "dev": true,
+      "funding": [
+        {
+          "type": "github",
+          "url": "https://github.com/sponsors/csstools"
+        },
+        {
+          "type": "opencollective",
+          "url": "https://opencollective.com/csstools"
+        }
+      ],
+      "license": "MIT",
+      "dependencies": {
+        "@csstools/color-helpers": "^5.1.0",
+        "@csstools/css-calc": "^2.1.4"
+      },
+      "engines": {
+        "node": ">=18"
+      },
+      "peerDependencies": {
+        "@csstools/css-parser-algorithms": "^3.0.5",
+        "@csstools/css-tokenizer": "^3.0.4"
+      }
+    },
+    "node_modules/@csstools/css-parser-algorithms": {
+      "version": "3.0.5",
+      "resolved": "https://registry.npmjs.org/@csstools/css-parser-algorithms/-/css-parser-algorithms-3.0.5.tgz",
+      "integrity": "sha512-DaDeUkXZKjdGhgYaHNJTV9pV7Y9B3b644jCLs9Upc3VeNGg6LWARAT6O+Q+/COo+2gg/bM5rhpMAtf70WqfBdQ==",
+      "dev": true,
+      "funding": [
+        {
+          "type": "github",
+          "url": "https://github.com/sponsors/csstools"
+        },
+        {
+          "type": "opencollective",
+          "url": "https://opencollective.com/csstools"
+        }
+      ],
+      "license": "MIT",
+      "engines": {
+        "node": ">=18"
+      },
+      "peerDependencies": {
+        "@csstools/css-tokenizer": "^3.0.4"
+      }
+    },
+    "node_modules/@csstools/css-tokenizer": {
+      "version": "3.0.4",
+      "resolved": "https://registry.npmjs.org/@csstools/css-tokenizer/-/css-tokenizer-3.0.4.tgz",
+      "integrity": "sha512-Vd/9EVDiu6PPJt9yAh6roZP6El1xHrdvIVGjyBsHR0RYwNHgL7FJPyIIW4fANJNG6FtyZfvlRPpFI4ZM/lubvw==",
+      "dev": true,
+      "funding": [
+        {
+          "type": "github",
+          "url": "https://github.com/sponsors/csstools"
+        },
+        {
+          "type": "opencollective",
+          "url": "https://opencollective.com/csstools"
+        }
+      ],
+      "license": "MIT",
+      "engines": {
+        "node": ">=18"
+      }
+    },
     "node_modules/@esbuild/aix-ppc64": {
       "version": "0.21.5",
       "resolved": "https://registry.npmjs.org/@esbuild/aix-ppc64/-/aix-ppc64-0.21.5.tgz",
@@ -1182,6 +1327,78 @@
       "dev": true,
       "license": "MIT"
     },
+    "node_modules/@types/d3-array": {
+      "version": "3.2.2",
+      "resolved": "https://registry.npmjs.org/@types/d3-array/-/d3-array-3.2.2.tgz",
+      "integrity": "sha512-hOLWVbm7uRza0BYXpIIW5pxfrKe0W+D5lrFiAEYR+pb6w3N2SwSMaJbXdUfSEv+dT4MfHBLtn5js0LAWaO6otw==",
+      "dev": true,
+      "license": "MIT"
+    },
+    "node_modules/@types/d3-color": {
+      "version": "3.1.3",
+      "resolved": "https://registry.npmjs.org/@types/d3-color/-/d3-color-3.1.3.tgz",
+      "integrity": "sha512-iO90scth9WAbmgv7ogoq57O9YpKmFBbmoEoCHDB2xMBY0+/KVrqAaCDyCE16dUspeOvIxFFRI+0sEtqDqy2b4A==",
+      "dev": true,
+      "license": "MIT"
+    },
+    "node_modules/@types/d3-ease": {
+      "version": "3.0.2",
+      "resolved": "https://registry.npmjs.org/@types/d3-ease/-/d3-ease-3.0.2.tgz",
+      "integrity": "sha512-NcV1JjO5oDzoK26oMzbILE6HW7uVXOHLQvHshBUW4UMdZGfiY6v5BeQwh9a9tCzv+CeefZQHJt5SRgK154RtiA==",
+      "dev": true,
+      "license": "MIT"
+    },
+    "node_modules/@types/d3-interpolate": {
+      "version": "3.0.4",
+      "resolved": "https://registry.npmjs.org/@types/d3-interpolate/-/d3-interpolate-3.0.4.tgz",
+      "integrity": "sha512-mgLPETlrpVV1YRJIglr4Ez47g7Yxjl1lj7YKsiMCb27VJH9W8NVM6Bb9d8kkpG/uAQS5AmbA48q2IAolKKo1MA==",
+      "dev": true,
+      "license": "MIT",
+      "dependencies": {
+        "@types/d3-color": "*"
+      }
+    },
+    "node_modules/@types/d3-path": {
+      "version": "3.1.1",
+      "resolved": "https://registry.npmjs.org/@types/d3-path/-/d3-path-3.1.1.tgz",
+      "integrity": "sha512-VMZBYyQvbGmWyWVea0EHs/BwLgxc+MKi1zLDCONksozI4YJMcTt8ZEuIR4Sb1MMTE8MMW49v0IwI5+b7RmfWlg==",
+      "dev": true,
+      "license": "MIT"
+    },
+    "node_modules/@types/d3-scale": {
+      "version": "4.0.9",
+      "resolved": "https://registry.npmjs.org/@types/d3-scale/-/d3-scale-4.0.9.tgz",
+      "integrity": "sha512-dLmtwB8zkAeO/juAMfnV+sItKjlsw2lKdZVVy6LRr0cBmegxSABiLEpGVmSJJ8O08i4+sGR6qQtb6WtuwJdvVw==",
+      "dev": true,
+      "license": "MIT",
+      "dependencies": {
+        "@types/d3-time": "*"
+      }
+    },
+    "node_modules/@types/d3-shape": {
+      "version": "3.1.8",
+      "resolved": "https://registry.npmjs.org/@types/d3-shape/-/d3-shape-3.1.8.tgz",
+      "integrity": "sha512-lae0iWfcDeR7qt7rA88BNiqdvPS5pFVPpo5OfjElwNaT2yyekbM0C9vK+yqBqEmHr6lDkRnYNoTBYlAgJa7a4w==",
+      "dev": true,
+      "license": "MIT",
+      "dependencies": {
+        "@types/d3-path": "*"
+      }
+    },
+    "node_modules/@types/d3-time": {
+      "version": "3.0.4",
+      "resolved": "https://registry.npmjs.org/@types/d3-time/-/d3-time-3.0.4.tgz",
+      "integrity": "sha512-yuzZug1nkAAaBlBBikKZTgzCeA+k1uy4ZFwWANOfKw5z5LRhV0gNA7gNkKm7HoK+HRN0wX3EkxGk0fpbWhmB7g==",
+      "dev": true,
+      "license": "MIT"
+    },
+    "node_modules/@types/d3-timer": {
+      "version": "3.0.2",
+      "resolved": "https://registry.npmjs.org/@types/d3-timer/-/d3-timer-3.0.2.tgz",
+      "integrity": "sha512-Ps3T8E8dZDam6fUyNiMkekK3XUsaUEik+idO9/YjPtfj2qruF8tFBXS7XhtE4iIXBLxhmLjP3SXpLhVf21I9Lw==",
+      "dev": true,
+      "license": "MIT"
+    },
     "node_modules/@types/eslint": {
       "version": "8.56.12",
       "resolved": "https://registry.npmjs.org/@types/eslint/-/eslint-8.56.12.tgz",
@@ -1224,6 +1441,34 @@
         "undici-types": "~6.21.0"
       }
     },
+    "node_modules/@types/prop-types": {
+      "version": "15.7.15",
+      "resolved": "https://registry.npmjs.org/@types/prop-types/-/prop-types-15.7.15.tgz",
+      "integrity": "sha512-F6bEyamV9jKGAFBEmlQnesRPGOQqS2+Uwi0Em15xenOxHaf2hv6L8YCVn3rPdPJOiJfPiCnLIRyvwVaqMY3MIw==",
+      "dev": true,
+      "license": "MIT"
+    },
+    "node_modules/@types/react": {
+      "version": "18.3.28",
+      "resolved": "https://registry.npmjs.org/@types/react/-/react-18.3.28.tgz",
+      "integrity": "sha512-z9VXpC7MWrhfWipitjNdgCauoMLRdIILQsAEV+ZesIzBq/oUlxk0m3ApZuMFCXdnS4U7KrI+l3WRUEGQ8K1QKw==",
+      "dev": true,
+      "license": "MIT",
+      "dependencies": {
+        "@types/prop-types": "*",
+        "csstype": "^3.2.2"
+      }
+    },
+    "node_modules/@types/react-dom": {
+      "version": "18.3.7",
+      "resolved": "https://registry.npmjs.org/@types/react-dom/-/react-dom-18.3.7.tgz",
+      "integrity": "sha512-MEe3UeoENYVFXzoXEWsvcpg6ZvlrFNlOQ7EOsvhI3CfAXwzPfO8Qwuxd40nepsYKqyyVQnTdEfv68q91yLcKrQ==",
+      "dev": true,
+      "license": "MIT",
+      "peerDependencies": {
+        "@types/react": "^18.0.0"
+      }
+    },
     "node_modules/@typescript-eslint/eslint-plugin": {
       "version": "7.18.0",
       "resolved": "https://registry.npmjs.org/@typescript-eslint/eslint-plugin/-/eslint-plugin-7.18.0.tgz",
@@ -1609,6 +1854,16 @@
         "node": ">=0.4.0"
       }
     },
+    "node_modules/agent-base": {
+      "version": "7.1.4",
+      "resolved": "https://registry.npmjs.org/agent-base/-/agent-base-7.1.4.tgz",
+      "integrity": "sha512-MnA+YT8fwfJPgBx3m60MNqakm30XOkyIoH1y6huTQvC0PwZG7ki8NacLBcrPbNoo8vEZy7Jpuk7+jMO+CUovTQ==",
+      "dev": true,
+      "license": "MIT",
+      "engines": {
+        "node": ">= 14"
+      }
+    },
     "node_modules/ajv": {
       "version": "6.14.0",
       "resolved": "https://registry.npmjs.org/ajv/-/ajv-6.14.0.tgz",
@@ -1746,6 +2001,13 @@
         "node": "*"
       }
     },
+    "node_modules/asynckit": {
+      "version": "0.4.0",
+      "resolved": "https://registry.npmjs.org/asynckit/-/asynckit-0.4.0.tgz",
+      "integrity": "sha512-Oei9OH4tRh0YqU3GxhX79dM/mwVgvbZJaSNaRk+bshkj0S5cfHcgYakreBjrHwatXKbz+IoIdYLxrKim2MjW0Q==",
+      "dev": true,
+      "license": "MIT"
+    },
     "node_modules/atomic-sleep": {
       "version": "1.0.0",
       "resolved": "https://registry.npmjs.org/atomic-sleep/-/atomic-sleep-1.0.0.tgz",
@@ -1860,6 +2122,20 @@
         "node": ">=8"
       }
     },
+    "node_modules/call-bind-apply-helpers": {
+      "version": "1.0.2",
+      "resolved": "https://registry.npmjs.org/call-bind-apply-helpers/-/call-bind-apply-helpers-1.0.2.tgz",
+      "integrity": "sha512-Sp1ablJ0ivDkSzjcaJdxEunN5/XvksFJ2sMBFfq6x0ryhQV/2b/KwFe21cMpmHtPOSij8K99/wSfoEuTObmuMQ==",
+      "dev": true,
+      "license": "MIT",
+      "dependencies": {
+        "es-errors": "^1.3.0",
+        "function-bind": "^1.1.2"
+      },
+      "engines": {
+        "node": ">= 0.4"
+      }
+    },
     "node_modules/callsites": {
       "version": "3.1.0",
       "resolved": "https://registry.npmjs.org/callsites/-/callsites-3.1.0.tgz",
@@ -1943,6 +2219,16 @@
         "fsevents": "~2.3.2"
       }
     },
+    "node_modules/clsx": {
+      "version": "2.1.1",
+      "resolved": "https://registry.npmjs.org/clsx/-/clsx-2.1.1.tgz",
+      "integrity": "sha512-eYm0QWBtUrBWZWG0d386OGAw16Z995PiOVo2B7bjWSbHedGl5e0ZWaq65kOGgUSNesEIDkB9ISbTg/JK9dhCZA==",
+      "dev": true,
+      "license": "MIT",
+      "engines": {
+        "node": ">=6"
+      }
+    },
     "node_modules/color-convert": {
       "version": "2.0.1",
       "resolved": "https://registry.npmjs.org/color-convert/-/color-convert-2.0.1.tgz",
@@ -1969,6 +2255,19 @@
       "integrity": "sha512-IfEDxwoWIjkeXL1eXcDiow4UbKjhLdq6/EuSVR9GMN7KVH3r9gQ83e73hsz1Nd1T3ijd5xv1wcWRYO+D6kCI2w==",
       "license": "MIT"
     },
+    "node_modules/combined-stream": {
+      "version": "1.0.8",
+      "resolved": "https://registry.npmjs.org/combined-stream/-/combined-stream-1.0.8.tgz",
+      "integrity": "sha512-FQN4MRfuJeHf7cBbBMJFXhKSDq+2kAArBlmRBvcvFE5BB1HZKXtSFASDhdlz9zOYwxh8lDdnvmMOe/+5cdoEdg==",
+      "dev": true,
+      "license": "MIT",
+      "dependencies": {
+        "delayed-stream": "~1.0.0"
+      },
+      "engines": {
+        "node": ">= 0.8"
+      }
+    },
     "node_modules/commander": {
       "version": "12.1.0",
       "resolved": "https://registry.npmjs.org/commander/-/commander-12.1.0.tgz",
@@ -2016,87 +2315,311 @@
         "node": ">= 8"
       }
     },
-    "node_modules/dateformat": {
-      "version": "4.6.3",
-      "resolved": "https://registry.npmjs.org/dateformat/-/dateformat-4.6.3.tgz",
-      "integrity": "sha512-2P0p0pFGzHS5EMnhdxQi7aJN+iMheud0UhG4dlE1DLAlvL8JHjJJTX/CSm4JXwV0Ka5nGk3zC5mcb5bUQUxxMA==",
-      "license": "MIT",
-      "engines": {
-        "node": "*"
-      }
-    },
-    "node_modules/debug": {
-      "version": "4.4.3",
-      "resolved": "https://registry.npmjs.org/debug/-/debug-4.4.3.tgz",
-      "integrity": "sha512-RGwwWnwQvkVfavKVt22FGLw+xYSdzARwm0ru6DhTVA3umU5hZc28V3kO4stgYryrTlLpuvgI9GiijltAjNbcqA==",
+    "node_modules/cssstyle": {
+      "version": "4.6.0",
+      "resolved": "https://registry.npmjs.org/cssstyle/-/cssstyle-4.6.0.tgz",
+      "integrity": "sha512-2z+rWdzbbSZv6/rhtvzvqeZQHrBaqgogqt85sqFNbabZOuFbCVFb8kPeEtZjiKkbrm395irpNKiYeFeLiQnFPg==",
       "dev": true,
       "license": "MIT",
       "dependencies": {
-        "ms": "^2.1.3"
+        "@asamuzakjp/css-color": "^3.2.0",
+        "rrweb-cssom": "^0.8.0"
       },
       "engines": {
-        "node": ">=6.0"
-      },
-      "peerDependenciesMeta": {
-        "supports-color": {
-          "optional": true
-        }
+        "node": ">=18"
       }
     },
-    "node_modules/deep-eql": {
-      "version": "4.1.4",
-      "resolved": "https://registry.npmjs.org/deep-eql/-/deep-eql-4.1.4.tgz",
-      "integrity": "sha512-SUwdGfqdKOwxCPeVYjwSyRpJ7Z+fhpwIAtmCUdZIWZ/YP5R9WAsyuSgpLVDi9bjWoN2LXHNss/dk3urXtdQxGg==",
+    "node_modules/cssstyle/node_modules/rrweb-cssom": {
+      "version": "0.8.0",
+      "resolved": "https://registry.npmjs.org/rrweb-cssom/-/rrweb-cssom-0.8.0.tgz",
+      "integrity": "sha512-guoltQEx+9aMf2gDZ0s62EcV8lsXR+0w8915TC3ITdn2YueuNjdAYh/levpU9nFaoChh9RUS5ZdQMrKfVEN9tw==",
       "dev": true,
-      "license": "MIT",
+      "license": "MIT"
+    },
+    "node_modules/csstype": {
+      "version": "3.2.3",
+      "resolved": "https://registry.npmjs.org/csstype/-/csstype-3.2.3.tgz",
+      "integrity": "sha512-z1HGKcYy2xA8AGQfwrn0PAy+PB7X/GSj3UVJW9qKyn43xWa+gl5nXmU4qqLMRzWVLFC8KusUX8T/0kCiOYpAIQ==",
+      "dev": true,
+      "license": "MIT"
+    },
+    "node_modules/d3-array": {
+      "version": "3.2.4",
+      "resolved": "https://registry.npmjs.org/d3-array/-/d3-array-3.2.4.tgz",
+      "integrity": "sha512-tdQAmyA18i4J7wprpYq8ClcxZy3SC31QMeByyCFyRt7BVHdREQZ5lpzoe5mFEYZUWe+oq8HBvk9JjpibyEV4Jg==",
+      "dev": true,
+      "license": "ISC",
       "dependencies": {
-        "type-detect": "^4.0.0"
+        "internmap": "1 - 2"
       },
       "engines": {
-        "node": ">=6"
+        "node": ">=12"
       }
     },
-    "node_modules/deep-is": {
-      "version": "0.1.4",
-      "resolved": "https://registry.npmjs.org/deep-is/-/deep-is-0.1.4.tgz",
-      "integrity": "sha512-oIPzksmTg4/MriiaYGO+okXDT7ztn/w3Eptv/+gSIdMdKsJo0u4CfYNFJPy+4SKMuCqGw2wxnA+URMg3t8a/bQ==",
+    "node_modules/d3-color": {
+      "version": "3.1.0",
+      "resolved": "https://registry.npmjs.org/d3-color/-/d3-color-3.1.0.tgz",
+      "integrity": "sha512-zg/chbXyeBtMQ1LbD/WSoW2DpC3I0mpmPdW+ynRTj/x2DAWYrIY7qeZIHidozwV24m4iavr15lNwIwLxRmOxhA==",
       "dev": true,
-      "license": "MIT"
+      "license": "ISC",
+      "engines": {
+        "node": ">=12"
+      }
     },
-    "node_modules/diff-sequences": {
-      "version": "29.6.3",
-      "resolved": "https://registry.npmjs.org/diff-sequences/-/diff-sequences-29.6.3.tgz",
-      "integrity": "sha512-EjePK1srD3P08o2j4f0ExnylqRs5B9tJjcp9t1krH2qRi8CCdsYfwe9JgSLurFBWwq4uOlipzfk5fHNvwFKr8Q==",
+    "node_modules/d3-ease": {
+      "version": "3.0.1",
+      "resolved": "https://registry.npmjs.org/d3-ease/-/d3-ease-3.0.1.tgz",
+      "integrity": "sha512-wR/XK3D3XcLIZwpbvQwQ5fK+8Ykds1ip7A2Txe0yxncXSdq1L9skcG7blcedkOX+ZcgxGAmLX1FrRGbADwzi0w==",
       "dev": true,
-      "license": "MIT",
+      "license": "BSD-3-Clause",
       "engines": {
-        "node": "^14.15.0 || ^16.10.0 || >=18.0.0"
+        "node": ">=12"
       }
     },
-    "node_modules/dir-glob": {
-      "version": "3.0.1",
-      "resolved": "https://registry.npmjs.org/dir-glob/-/dir-glob-3.0.1.tgz",
-      "integrity": "sha512-WkrWp9GR4KXfKGYzOLmTuGVi1UWFfws377n9cc55/tb6DuqyF6pcQ5AbiHEshaDpY9v6oaSr2XCDidGmMwdzIA==",
+    "node_modules/d3-format": {
+      "version": "3.1.2",
+      "resolved": "https://registry.npmjs.org/d3-format/-/d3-format-3.1.2.tgz",
+      "integrity": "sha512-AJDdYOdnyRDV5b6ArilzCPPwc1ejkHcoyFarqlPqT7zRYjhavcT3uSrqcMvsgh2CgoPbK3RCwyHaVyxYcP2Arg==",
       "dev": true,
-      "license": "MIT",
-      "dependencies": {
-        "path-type": "^4.0.0"
-      },
+      "license": "ISC",
       "engines": {
-        "node": ">=8"
+        "node": ">=12"
       }
     },
-    "node_modules/doctrine": {
-      "version": "3.0.0",
-      "resolved": "https://registry.npmjs.org/doctrine/-/doctrine-3.0.0.tgz",
-      "integrity": "sha512-yS+Q5i3hBf7GBkd4KG8a7eBNNWNGLTaEwwYWUijIYM7zrlYDM0BFXHjjPWlWZ1Rg7UaddZeIDmi9jF3HmqiQ2w==",
+    "node_modules/d3-interpolate": {
+      "version": "3.0.1",
+      "resolved": "https://registry.npmjs.org/d3-interpolate/-/d3-interpolate-3.0.1.tgz",
+      "integrity": "sha512-3bYs1rOD33uo8aqJfKP3JWPAibgw8Zm2+L9vBKEHJ2Rg+viTR7o5Mmv5mZcieN+FRYaAOWX5SJATX6k1PWz72g==",
       "dev": true,
-      "license": "Apache-2.0",
+      "license": "ISC",
       "dependencies": {
-        "esutils": "^2.0.2"
+        "d3-color": "1 - 3"
       },
       "engines": {
-        "node": ">=6.0.0"
+        "node": ">=12"
+      }
+    },
+    "node_modules/d3-path": {
+      "version": "3.1.0",
+      "resolved": "https://registry.npmjs.org/d3-path/-/d3-path-3.1.0.tgz",
+      "integrity": "sha512-p3KP5HCf/bvjBSSKuXid6Zqijx7wIfNW+J/maPs+iwR35at5JCbLUT0LzF1cnjbCHWhqzQTIN2Jpe8pRebIEFQ==",
+      "dev": true,
+      "license": "ISC",
+      "engines": {
+        "node": ">=12"
+      }
+    },
+    "node_modules/d3-scale": {
+      "version": "4.0.2",
+      "resolved": "https://registry.npmjs.org/d3-scale/-/d3-scale-4.0.2.tgz",
+      "integrity": "sha512-GZW464g1SH7ag3Y7hXjf8RoUuAFIqklOAq3MRl4OaWabTFJY9PN/E1YklhXLh+OQ3fM9yS2nOkCoS+WLZ6kvxQ==",
+      "dev": true,
+      "license": "ISC",
+      "dependencies": {
+        "d3-array": "2.10.0 - 3",
+        "d3-format": "1 - 3",
+        "d3-interpolate": "1.2.0 - 3",
+        "d3-time": "2.1.1 - 3",
+        "d3-time-format": "2 - 4"
+      },
+      "engines": {
+        "node": ">=12"
+      }
+    },
+    "node_modules/d3-shape": {
+      "version": "3.2.0",
+      "resolved": "https://registry.npmjs.org/d3-shape/-/d3-shape-3.2.0.tgz",
+      "integrity": "sha512-SaLBuwGm3MOViRq2ABk3eLoxwZELpH6zhl3FbAoJ7Vm1gofKx6El1Ib5z23NUEhF9AsGl7y+dzLe5Cw2AArGTA==",
+      "dev": true,
+      "license": "ISC",
+      "dependencies": {
+        "d3-path": "^3.1.0"
+      },
+      "engines": {
+        "node": ">=12"
+      }
+    },
+    "node_modules/d3-time": {
+      "version": "3.1.0",
+      "resolved": "https://registry.npmjs.org/d3-time/-/d3-time-3.1.0.tgz",
+      "integrity": "sha512-VqKjzBLejbSMT4IgbmVgDjpkYrNWUYJnbCGo874u7MMKIWsILRX+OpX/gTk8MqjpT1A/c6HY2dCA77ZN0lkQ2Q==",
+      "dev": true,
+      "license": "ISC",
+      "dependencies": {
+        "d3-array": "2 - 3"
+      },
+      "engines": {
+        "node": ">=12"
+      }
+    },
+    "node_modules/d3-time-format": {
+      "version": "4.1.0",
+      "resolved": "https://registry.npmjs.org/d3-time-format/-/d3-time-format-4.1.0.tgz",
+      "integrity": "sha512-dJxPBlzC7NugB2PDLwo9Q8JiTR3M3e4/XANkreKSUxF8vvXKqm1Yfq4Q5dl8budlunRVlUUaDUgFt7eA8D6NLg==",
+      "dev": true,
+      "license": "ISC",
+      "dependencies": {
+        "d3-time": "1 - 3"
+      },
+      "engines": {
+        "node": ">=12"
+      }
+    },
+    "node_modules/d3-timer": {
+      "version": "3.0.1",
+      "resolved": "https://registry.npmjs.org/d3-timer/-/d3-timer-3.0.1.tgz",
+      "integrity": "sha512-ndfJ/JxxMd3nw31uyKoY2naivF+r29V+Lc0svZxe1JvvIRmi8hUsrMvdOwgS1o6uBHmiz91geQ0ylPP0aj1VUA==",
+      "dev": true,
+      "license": "ISC",
+      "engines": {
+        "node": ">=12"
+      }
+    },
+    "node_modules/data-urls": {
+      "version": "5.0.0",
+      "resolved": "https://registry.npmjs.org/data-urls/-/data-urls-5.0.0.tgz",
+      "integrity": "sha512-ZYP5VBHshaDAiVZxjbRVcFJpc+4xGgT0bK3vzy1HLN8jTO975HEbuYzZJcHoQEY5K1a0z8YayJkyVETa08eNTg==",
+      "dev": true,
+      "license": "MIT",
+      "dependencies": {
+        "whatwg-mimetype": "^4.0.0",
+        "whatwg-url": "^14.0.0"
+      },
+      "engines": {
+        "node": ">=18"
+      }
+    },
+    "node_modules/dateformat": {
+      "version": "4.6.3",
+      "resolved": "https://registry.npmjs.org/dateformat/-/dateformat-4.6.3.tgz",
+      "integrity": "sha512-2P0p0pFGzHS5EMnhdxQi7aJN+iMheud0UhG4dlE1DLAlvL8JHjJJTX/CSm4JXwV0Ka5nGk3zC5mcb5bUQUxxMA==",
+      "license": "MIT",
+      "engines": {
+        "node": "*"
+      }
+    },
+    "node_modules/debug": {
+      "version": "4.4.3",
+      "resolved": "https://registry.npmjs.org/debug/-/debug-4.4.3.tgz",
+      "integrity": "sha512-RGwwWnwQvkVfavKVt22FGLw+xYSdzARwm0ru6DhTVA3umU5hZc28V3kO4stgYryrTlLpuvgI9GiijltAjNbcqA==",
+      "dev": true,
+      "license": "MIT",
+      "dependencies": {
+        "ms": "^2.1.3"
+      },
+      "engines": {
+        "node": ">=6.0"
+      },
+      "peerDependenciesMeta": {
+        "supports-color": {
+          "optional": true
+        }
+      }
+    },
+    "node_modules/decimal.js": {
+      "version": "10.6.0",
+      "resolved": "https://registry.npmjs.org/decimal.js/-/decimal.js-10.6.0.tgz",
+      "integrity": "sha512-YpgQiITW3JXGntzdUmyUR1V812Hn8T1YVXhCu+wO3OpS4eU9l4YdD3qjyiKdV6mvV29zapkMeD390UVEf2lkUg==",
+      "dev": true,
+      "license": "MIT"
+    },
+    "node_modules/decimal.js-light": {
+      "version": "2.5.1",
+      "resolved": "https://registry.npmjs.org/decimal.js-light/-/decimal.js-light-2.5.1.tgz",
+      "integrity": "sha512-qIMFpTMZmny+MMIitAB6D7iVPEorVw6YQRWkvarTkT4tBeSLLiHzcwj6q0MmYSFCiVpiqPJTJEYIrpcPzVEIvg==",
+      "dev": true,
+      "license": "MIT"
+    },
+    "node_modules/deep-eql": {
+      "version": "4.1.4",
+      "resolved": "https://registry.npmjs.org/deep-eql/-/deep-eql-4.1.4.tgz",
+      "integrity": "sha512-SUwdGfqdKOwxCPeVYjwSyRpJ7Z+fhpwIAtmCUdZIWZ/YP5R9WAsyuSgpLVDi9bjWoN2LXHNss/dk3urXtdQxGg==",
+      "dev": true,
+      "license": "MIT",
+      "dependencies": {
+        "type-detect": "^4.0.0"
+      },
+      "engines": {
+        "node": ">=6"
+      }
+    },
+    "node_modules/deep-is": {
+      "version": "0.1.4",
+      "resolved": "https://registry.npmjs.org/deep-is/-/deep-is-0.1.4.tgz",
+      "integrity": "sha512-oIPzksmTg4/MriiaYGO+okXDT7ztn/w3Eptv/+gSIdMdKsJo0u4CfYNFJPy+4SKMuCqGw2wxnA+URMg3t8a/bQ==",
+      "dev": true,
+      "license": "MIT"
+    },
+    "node_modules/delayed-stream": {
+      "version": "1.0.0",
+      "resolved": "https://registry.npmjs.org/delayed-stream/-/delayed-stream-1.0.0.tgz",
+      "integrity": "sha512-ZySD7Nf91aLB0RxL4KGrKHBXl7Eds1DAmEdcoVawXnLD7SDhpNgtuII2aAkg7a7QS41jxPSZ17p4VdGnMHk3MQ==",
+      "dev": true,
+      "license": "MIT",
+      "engines": {
+        "node": ">=0.4.0"
+      }
+    },
+    "node_modules/diff-sequences": {
+      "version": "29.6.3",
+      "resolved": "https://registry.npmjs.org/diff-sequences/-/diff-sequences-29.6.3.tgz",
+      "integrity": "sha512-EjePK1srD3P08o2j4f0ExnylqRs5B9tJjcp9t1krH2qRi8CCdsYfwe9JgSLurFBWwq4uOlipzfk5fHNvwFKr8Q==",
+      "dev": true,
+      "license": "MIT",
+      "engines": {
+        "node": "^14.15.0 || ^16.10.0 || >=18.0.0"
+      }
+    },
+    "node_modules/dir-glob": {
+      "version": "3.0.1",
+      "resolved": "https://registry.npmjs.org/dir-glob/-/dir-glob-3.0.1.tgz",
+      "integrity": "sha512-WkrWp9GR4KXfKGYzOLmTuGVi1UWFfws377n9cc55/tb6DuqyF6pcQ5AbiHEshaDpY9v6oaSr2XCDidGmMwdzIA==",
+      "dev": true,
+      "license": "MIT",
+      "dependencies": {
+        "path-type": "^4.0.0"
+      },
+      "engines": {
+        "node": ">=8"
+      }
+    },
+    "node_modules/doctrine": {
+      "version": "3.0.0",
+      "resolved": "https://registry.npmjs.org/doctrine/-/doctrine-3.0.0.tgz",
+      "integrity": "sha512-yS+Q5i3hBf7GBkd4KG8a7eBNNWNGLTaEwwYWUijIYM7zrlYDM0BFXHjjPWlWZ1Rg7UaddZeIDmi9jF3HmqiQ2w==",
+      "dev": true,
+      "license": "Apache-2.0",
+      "dependencies": {
+        "esutils": "^2.0.2"
+      },
+      "engines": {
+        "node": ">=6.0.0"
+      }
+    },
+    "node_modules/dom-helpers": {
+      "version": "5.2.1",
+      "resolved": "https://registry.npmjs.org/dom-helpers/-/dom-helpers-5.2.1.tgz",
+      "integrity": "sha512-nRCa7CK3VTrM2NmGkIy4cbK7IZlgBE/PYMn55rrXefr5xXDP0LdtfPnblFDoVdcAfslJ7or6iqAUnx0CCGIWQA==",
+      "dev": true,
+      "license": "MIT",
+      "dependencies": {
+        "@babel/runtime": "^7.8.7",
+        "csstype": "^3.0.2"
+      }
+    },
+    "node_modules/dunder-proto": {
+      "version": "1.0.1",
+      "resolved": "https://registry.npmjs.org/dunder-proto/-/dunder-proto-1.0.1.tgz",
+      "integrity": "sha512-KIN/nDJBQRcXw0MLVhZE9iQHmG68qAVIBg9CqmUYjmQIhgij9U5MFvrqkUL5FbtyyzZuOeOt0zdeRe4UY7ct+A==",
+      "dev": true,
+      "license": "MIT",
+      "dependencies": {
+        "call-bind-apply-helpers": "^1.0.1",
+        "es-errors": "^1.3.0",
+        "gopd": "^1.2.0"
+      },
+      "engines": {
+        "node": ">= 0.4"
       }
     },
     "node_modules/end-of-stream": {
@@ -2108,6 +2631,68 @@
         "once": "^1.4.0"
       }
     },
+    "node_modules/entities": {
+      "version": "6.0.1",
+      "resolved": "https://registry.npmjs.org/entities/-/entities-6.0.1.tgz",
+      "integrity": "sha512-aN97NXWF6AWBTahfVOIrB/NShkzi5H7F9r1s9mD3cDj4Ko5f2qhhVoYMibXF7GlLveb/D2ioWay8lxI97Ven3g==",
+      "dev": true,
+      "license": "BSD-2-Clause",
+      "engines": {
+        "node": ">=0.12"
+      },
+      "funding": {
+        "url": "https://github.com/fb55/entities?sponsor=1"
+      }
+    },
+    "node_modules/es-define-property": {
+      "version": "1.0.1",
+      "resolved": "https://registry.npmjs.org/es-define-property/-/es-define-property-1.0.1.tgz",
+      "integrity": "sha512-e3nRfgfUZ4rNGL232gUgX06QNyyez04KdjFrF+LTRoOXmrOgFKDg4BCdsjW8EnT69eqdYGmRpJwiPVYNrCaW3g==",
+      "dev": true,
+      "license": "MIT",
+      "engines": {
+        "node": ">= 0.4"
+      }
+    },
+    "node_modules/es-errors": {
+      "version": "1.3.0",
+      "resolved": "https://registry.npmjs.org/es-errors/-/es-errors-1.3.0.tgz",
+      "integrity": "sha512-Zf5H2Kxt2xjTvbJvP2ZWLEICxA6j+hAmMzIlypy4xcBg1vKVnx89Wy0GbS+kf5cwCVFFzdCFh2XSCFNULS6csw==",
+      "dev": true,
+      "license": "MIT",
+      "engines": {
+        "node": ">= 0.4"
+      }
+    },
+    "node_modules/es-object-atoms": {
+      "version": "1.1.1",
+      "resolved": "https://registry.npmjs.org/es-object-atoms/-/es-object-atoms-1.1.1.tgz",
+      "integrity": "sha512-FGgH2h8zKNim9ljj7dankFPcICIK9Cp5bm+c2gQSYePhpaG5+esrLODihIorn+Pe6FGJzWhXQotPv73jTaldXA==",
+      "dev": true,
+      "license": "MIT",
+      "dependencies": {
+        "es-errors": "^1.3.0"
+      },
+      "engines": {
+        "node": ">= 0.4"
+      }
+    },
+    "node_modules/es-set-tostringtag": {
+      "version": "2.1.0",
+      "resolved": "https://registry.npmjs.org/es-set-tostringtag/-/es-set-tostringtag-2.1.0.tgz",
+      "integrity": "sha512-j6vWzfrGVfyXxge+O0x5sh6cvxAog0a/4Rdd2K36zCMV5eJ+/+tOAngRO8cODMNWbVRdVlmGZQL2YS3yR8bIUA==",
+      "dev": true,
+      "license": "MIT",
+      "dependencies": {
+        "es-errors": "^1.3.0",
+        "get-intrinsic": "^1.2.6",
+        "has-tostringtag": "^1.0.2",
+        "hasown": "^2.0.2"
+      },
+      "engines": {
+        "node": ">= 0.4"
+      }
+    },
     "node_modules/esbuild": {
       "version": "0.21.5",
       "resolved": "https://registry.npmjs.org/esbuild/-/esbuild-0.21.5.tgz",
@@ -2367,6 +2952,13 @@
         "node": ">=6"
       }
     },
+    "node_modules/eventemitter3": {
+      "version": "4.0.7",
+      "resolved": "https://registry.npmjs.org/eventemitter3/-/eventemitter3-4.0.7.tgz",
+      "integrity": "sha512-8guHBZCwKnFhYdHr2ysuRWErTwhoN2X8XELRlrRwpmfeY2jjuUN4taQMsULKUVo1K4DvZl+0pgfyoysHxvmvEw==",
+      "dev": true,
+      "license": "MIT"
+    },
     "node_modules/events": {
       "version": "3.3.0",
       "resolved": "https://registry.npmjs.org/events/-/events-3.3.0.tgz",
@@ -2424,6 +3016,16 @@
       "integrity": "sha512-f3qQ9oQy9j2AhBe/H9VC91wLmKBCCU/gDOnKNAYG5hswO7BLKj09Hc5HYNz9cGI++xlpDCIgDaitVs03ATR84Q==",
       "license": "MIT"
     },
+    "node_modules/fast-equals": {
+      "version": "5.4.0",
+      "resolved": "https://registry.npmjs.org/fast-equals/-/fast-equals-5.4.0.tgz",
+      "integrity": "sha512-jt2DW/aNFNwke7AUd+Z+e6pz39KO5rzdbbFCg2sGafS4mk13MI7Z8O5z9cADNn5lhGODIgLwug6TZO2ctf7kcw==",
+      "dev": true,
+      "license": "MIT",
+      "engines": {
+        "node": ">=6.0.0"
+      }
+    },
     "node_modules/fast-glob": {
       "version": "3.3.3",
       "resolved": "https://registry.npmjs.org/fast-glob/-/fast-glob-3.3.3.tgz",
@@ -2667,6 +3269,23 @@
       "dev": true,
       "license": "ISC"
     },
+    "node_modules/form-data": {
+      "version": "4.0.5",
+      "resolved": "https://registry.npmjs.org/form-data/-/form-data-4.0.5.tgz",
+      "integrity": "sha512-8RipRLol37bNs2bhoV67fiTEvdTrbMUYcFTiy3+wuuOnUog2QBHCZWXDRijWQfAkhBj2Uf5UnVaiWwA5vdd82w==",
+      "dev": true,
+      "license": "MIT",
+      "dependencies": {
+        "asynckit": "^0.4.0",
+        "combined-stream": "^1.0.8",
+        "es-set-tostringtag": "^2.1.0",
+        "hasown": "^2.0.2",
+        "mime-types": "^2.1.12"
+      },
+      "engines": {
+        "node": ">= 6"
+      }
+    },
     "node_modules/forwarded": {
       "version": "0.2.0",
       "resolved": "https://registry.npmjs.org/forwarded/-/forwarded-0.2.0.tgz",
@@ -2697,6 +3316,16 @@
         "node": "^8.16.0 || ^10.6.0 || >=11.0.0"
       }
     },
+    "node_modules/function-bind": {
+      "version": "1.1.2",
+      "resolved": "https://registry.npmjs.org/function-bind/-/function-bind-1.1.2.tgz",
+      "integrity": "sha512-7XHNxH7qX9xG5mIwxkhumTox/MIRNcOgDrxWsMt2pAr23WHp6MrRlN7FBSFpCpr+oVO0F744iUgR82nJMfG2SA==",
+      "dev": true,
+      "license": "MIT",
+      "funding": {
+        "url": "https://github.com/sponsors/ljharb"
+      }
+    },
     "node_modules/get-func-name": {
       "version": "2.0.2",
       "resolved": "https://registry.npmjs.org/get-func-name/-/get-func-name-2.0.2.tgz",
@@ -2707,6 +3336,45 @@
         "node": "*"
       }
     },
+    "node_modules/get-intrinsic": {
+      "version": "1.3.0",
+      "resolved": "https://registry.npmjs.org/get-intrinsic/-/get-intrinsic-1.3.0.tgz",
+      "integrity": "sha512-9fSjSaos/fRIVIp+xSJlE6lfwhES7LNtKaCBIamHsjr2na1BiABJPo0mOjjz8GJDURarmCPGqaiVg5mfjb98CQ==",
+      "dev": true,
+      "license": "MIT",
+      "dependencies": {
+        "call-bind-apply-helpers": "^1.0.2",
+        "es-define-property": "^1.0.1",
+        "es-errors": "^1.3.0",
+        "es-object-atoms": "^1.1.1",
+        "function-bind": "^1.1.2",
+        "get-proto": "^1.0.1",
+        "gopd": "^1.2.0",
+        "has-symbols": "^1.1.0",
+        "hasown": "^2.0.2",
+        "math-intrinsics": "^1.1.0"
+      },
+      "engines": {
+        "node": ">= 0.4"
+      },
+      "funding": {
+        "url": "https://github.com/sponsors/ljharb"
+      }
+    },
+    "node_modules/get-proto": {
+      "version": "1.0.1",
+      "resolved": "https://registry.npmjs.org/get-proto/-/get-proto-1.0.1.tgz",
+      "integrity": "sha512-sTSfBjoXBp89JvIKIefqw7U2CCebsc74kiY6awiGogKtoSGbgjYE/G/+l9sF3MWFPNc9IcoOC4ODfKHfxFmp0g==",
+      "dev": true,
+      "license": "MIT",
+      "dependencies": {
+        "dunder-proto": "^1.0.1",
+        "es-object-atoms": "^1.0.0"
+      },
+      "engines": {
+        "node": ">= 0.4"
+      }
+    },
     "node_modules/get-stream": {
       "version": "8.0.1",
       "resolved": "https://registry.npmjs.org/get-stream/-/get-stream-8.0.1.tgz",
@@ -2815,6 +3483,19 @@
         "url": "https://github.com/sponsors/sindresorhus"
       }
     },
+    "node_modules/gopd": {
+      "version": "1.2.0",
+      "resolved": "https://registry.npmjs.org/gopd/-/gopd-1.2.0.tgz",
+      "integrity": "sha512-ZUKRh6/kUFoAiTAtTYPZJ3hw9wNxx+BIBOijnlG9PnrJsCcSjs1wyyD6vJpaYtgnzDrKYRSqf3OO6Rfa93xsRg==",
+      "dev": true,
+      "license": "MIT",
+      "engines": {
+        "node": ">= 0.4"
+      },
+      "funding": {
+        "url": "https://github.com/sponsors/ljharb"
+      }
+    },
     "node_modules/graphemer": {
       "version": "1.4.0",
       "resolved": "https://registry.npmjs.org/graphemer/-/graphemer-1.4.0.tgz",
@@ -2832,12 +3513,67 @@
         "node": ">=8"
       }
     },
+    "node_modules/has-symbols": {
+      "version": "1.1.0",
+      "resolved": "https://registry.npmjs.org/has-symbols/-/has-symbols-1.1.0.tgz",
+      "integrity": "sha512-1cDNdwJ2Jaohmb3sg4OmKaMBwuC48sYni5HUw2DvsC8LjGTLK9h+eb1X6RyuOHe4hT0ULCW68iomhjUoKUqlPQ==",
+      "dev": true,
+      "license": "MIT",
+      "engines": {
+        "node": ">= 0.4"
+      },
+      "funding": {
+        "url": "https://github.com/sponsors/ljharb"
+      }
+    },
+    "node_modules/has-tostringtag": {
+      "version": "1.0.2",
+      "resolved": "https://registry.npmjs.org/has-tostringtag/-/has-tostringtag-1.0.2.tgz",
+      "integrity": "sha512-NqADB8VjPFLM2V0VvHUewwwsw0ZWBaIdgo+ieHtK3hasLz4qeCRjYcqfB6AQrBggRKppKF8L52/VqdVsO47Dlw==",
+      "dev": true,
+      "license": "MIT",
+      "dependencies": {
+        "has-symbols": "^1.0.3"
+      },
+      "engines": {
+        "node": ">= 0.4"
+      },
+      "funding": {
+        "url": "https://github.com/sponsors/ljharb"
+      }
+    },
+    "node_modules/hasown": {
+      "version": "2.0.3",
+      "resolved": "https://registry.npmjs.org/hasown/-/hasown-2.0.3.tgz",
+      "integrity": "sha512-ej4AhfhfL2Q2zpMmLo7U1Uv9+PyhIZpgQLGT1F9miIGmiCJIoCgSmczFdrc97mWT4kVY72KA+WnnhJ5pghSvSg==",
+      "dev": true,
+      "license": "MIT",
+      "dependencies": {
+        "function-bind": "^1.1.2"
+      },
+      "engines": {
+        "node": ">= 0.4"
+      }
+    },
     "node_modules/help-me": {
       "version": "5.0.0",
       "resolved": "https://registry.npmjs.org/help-me/-/help-me-5.0.0.tgz",
       "integrity": "sha512-7xgomUX6ADmcYzFik0HzAxh/73YlKR9bmFzf51CZwR+b6YtzU2m0u49hQCqV6SvlqIqsaxovfwdvbnsw3b/zpg==",
       "license": "MIT"
     },
+    "node_modules/html-encoding-sniffer": {
+      "version": "4.0.0",
+      "resolved": "https://registry.npmjs.org/html-encoding-sniffer/-/html-encoding-sniffer-4.0.0.tgz",
+      "integrity": "sha512-Y22oTqIU4uuPgEemfz7NDJz6OeKf12Lsu+QC+s3BVpda64lTiMYCyGwg5ki4vFxkMwQdeZDl2adZoqUgdFuTgQ==",
+      "dev": true,
+      "license": "MIT",
+      "dependencies": {
+        "whatwg-encoding": "^3.1.1"
+      },
+      "engines": {
+        "node": ">=18"
+      }
+    },
     "node_modules/html-escaper": {
       "version": "2.0.2",
       "resolved": "https://registry.npmjs.org/html-escaper/-/html-escaper-2.0.2.tgz",
@@ -2845,6 +3581,34 @@
       "dev": true,
       "license": "MIT"
     },
+    "node_modules/http-proxy-agent": {
+      "version": "7.0.2",
+      "resolved": "https://registry.npmjs.org/http-proxy-agent/-/http-proxy-agent-7.0.2.tgz",
+      "integrity": "sha512-T1gkAiYYDWYx3V5Bmyu7HcfcvL7mUrTWiM6yOfa3PIphViJ/gFPbvidQ+veqSOHci/PxBcDabeUNCzpOODJZig==",
+      "dev": true,
+      "license": "MIT",
+      "dependencies": {
+        "agent-base": "^7.1.0",
+        "debug": "^4.3.4"
+      },
+      "engines": {
+        "node": ">= 14"
+      }
+    },
+    "node_modules/https-proxy-agent": {
+      "version": "7.0.6",
+      "resolved": "https://registry.npmjs.org/https-proxy-agent/-/https-proxy-agent-7.0.6.tgz",
+      "integrity": "sha512-vK9P5/iUfdl95AI+JVyUuIcVtd4ofvtrOr3HNtM2yxC9bnMbEdp3x01OhQNnjb8IJYi38VlTE3mBXwcfvywuSw==",
+      "dev": true,
+      "license": "MIT",
+      "dependencies": {
+        "agent-base": "^7.1.2",
+        "debug": "4"
+      },
+      "engines": {
+        "node": ">= 14"
+      }
+    },
     "node_modules/human-signals": {
       "version": "5.0.0",
       "resolved": "https://registry.npmjs.org/human-signals/-/human-signals-5.0.0.tgz",
@@ -2855,6 +3619,19 @@
         "node": ">=16.17.0"
       }
     },
+    "node_modules/iconv-lite": {
+      "version": "0.6.3",
+      "resolved": "https://registry.npmjs.org/iconv-lite/-/iconv-lite-0.6.3.tgz",
+      "integrity": "sha512-4fCk79wshMdzMp2rH06qWrJE4iolqLhCUH+OiuIgU++RB0+94NlDL81atO7GX55uUKueo0txHNtvEyI6D7WdMw==",
+      "dev": true,
+      "license": "MIT",
+      "dependencies": {
+        "safer-buffer": ">= 2.1.2 < 3.0.0"
+      },
+      "engines": {
+        "node": ">=0.10.0"
+      }
+    },
     "node_modules/ieee754": {
       "version": "1.2.1",
       "resolved": "https://registry.npmjs.org/ieee754/-/ieee754-1.2.1.tgz",
@@ -2931,6 +3708,16 @@
       "dev": true,
       "license": "ISC"
     },
+    "node_modules/internmap": {
+      "version": "2.0.3",
+      "resolved": "https://registry.npmjs.org/internmap/-/internmap-2.0.3.tgz",
+      "integrity": "sha512-5Hh7Y1wQbvY5ooGgPbDaL5iYLAPzMTUrjMulskHLH6wnv/A+1q5rgEaiuqEjB+oxGXIVZs1FF+R/KPN3ZSQYYg==",
+      "dev": true,
+      "license": "ISC",
+      "engines": {
+        "node": ">=12"
+      }
+    },
     "node_modules/ipaddr.js": {
       "version": "1.9.1",
       "resolved": "https://registry.npmjs.org/ipaddr.js/-/ipaddr.js-1.9.1.tgz",
@@ -2992,6 +3779,13 @@
         "node": ">=8"
       }
     },
+    "node_modules/is-potential-custom-element-name": {
+      "version": "1.0.1",
+      "resolved": "https://registry.npmjs.org/is-potential-custom-element-name/-/is-potential-custom-element-name-1.0.1.tgz",
+      "integrity": "sha512-bCYeRA2rVibKZd+s2625gGnGF/t7DSqDs4dP7CrLA1m7jKWz6pps0LpYLJN8Q64HtmPKJ1hrN3nzPNKFEKOUiQ==",
+      "dev": true,
+      "license": "MIT"
+    },
     "node_modules/is-stream": {
       "version": "3.0.0",
       "resolved": "https://registry.npmjs.org/is-stream/-/is-stream-3.0.0.tgz",
@@ -3103,6 +3897,47 @@
         "js-yaml": "bin/js-yaml.js"
       }
     },
+    "node_modules/jsdom": {
+      "version": "24.1.3",
+      "resolved": "https://registry.npmjs.org/jsdom/-/jsdom-24.1.3.tgz",
+      "integrity": "sha512-MyL55p3Ut3cXbeBEG7Hcv0mVM8pp8PBNWxRqchZnSfAiES1v1mRnMeFfaHWIPULpwsYfvO+ZmMZz5tGCnjzDUQ==",
+      "dev": true,
+      "license": "MIT",
+      "dependencies": {
+        "cssstyle": "^4.0.1",
+        "data-urls": "^5.0.0",
+        "decimal.js": "^10.4.3",
+        "form-data": "^4.0.0",
+        "html-encoding-sniffer": "^4.0.0",
+        "http-proxy-agent": "^7.0.2",
+        "https-proxy-agent": "^7.0.5",
+        "is-potential-custom-element-name": "^1.0.1",
+        "nwsapi": "^2.2.12",
+        "parse5": "^7.1.2",
+        "rrweb-cssom": "^0.7.1",
+        "saxes": "^6.0.0",
+        "symbol-tree": "^3.2.4",
+        "tough-cookie": "^4.1.4",
+        "w3c-xmlserializer": "^5.0.0",
+        "webidl-conversions": "^7.0.0",
+        "whatwg-encoding": "^3.1.1",
+        "whatwg-mimetype": "^4.0.0",
+        "whatwg-url": "^14.0.0",
+        "ws": "^8.18.0",
+        "xml-name-validator": "^5.0.0"
+      },
+      "engines": {
+        "node": ">=18"
+      },
+      "peerDependencies": {
+        "canvas": "^2.11.2"
+      },
+      "peerDependenciesMeta": {
+        "canvas": {
+          "optional": true
+        }
+      }
+    },
     "node_modules/json-buffer": {
       "version": "3.0.1",
       "resolved": "https://registry.npmjs.org/json-buffer/-/json-buffer-3.0.1.tgz",
@@ -3201,6 +4036,13 @@
         "url": "https://github.com/sponsors/sindresorhus"
       }
     },
+    "node_modules/lodash": {
+      "version": "4.18.1",
+      "resolved": "https://registry.npmjs.org/lodash/-/lodash-4.18.1.tgz",
+      "integrity": "sha512-dMInicTPVE8d1e5otfwmmjlxkZoUpiVLwyeTdUsi/Caj/gfzzblBcCE5sRHV/AsjuCmxWrte2TNGSYuCeCq+0Q==",
+      "dev": true,
+      "license": "MIT"
+    },
     "node_modules/lodash.merge": {
       "version": "4.6.2",
       "resolved": "https://registry.npmjs.org/lodash.merge/-/lodash.merge-4.6.2.tgz",
@@ -3208,6 +4050,26 @@
       "dev": true,
       "license": "MIT"
     },
+    "node_modules/loose-envify": {
+      "version": "1.4.0",
+      "resolved": "https://registry.npmjs.org/loose-envify/-/loose-envify-1.4.0.tgz",
+      "integrity": "sha512-lyuxPGr/Wfhrlem2CL/UcnUc1zcqKAImBDzukY7Y5F/yQiNdko6+fRLevlw1HgMySw7f611UIY408EtxRSoK3Q==",
+      "dev": true,
+      "license": "MIT",
+      "dependencies": {
+        "js-tokens": "^3.0.0 || ^4.0.0"
+      },
+      "bin": {
+        "loose-envify": "cli.js"
+      }
+    },
+    "node_modules/loose-envify/node_modules/js-tokens": {
+      "version": "4.0.0",
+      "resolved": "https://registry.npmjs.org/js-tokens/-/js-tokens-4.0.0.tgz",
+      "integrity": "sha512-RdJUflcE3cUzKiMqQgsCu06FPu9UdIJO0beYbPhHN4k6apgJtifcoCtT9bcxOpYBtpD2kCM6Sbzg4CausW/PKQ==",
+      "dev": true,
+      "license": "MIT"
+    },
     "node_modules/loupe": {
       "version": "2.3.7",
       "resolved": "https://registry.npmjs.org/loupe/-/loupe-2.3.7.tgz",
@@ -3218,6 +4080,13 @@
         "get-func-name": "^2.0.1"
       }
     },
+    "node_modules/lru-cache": {
+      "version": "10.4.3",
+      "resolved": "https://registry.npmjs.org/lru-cache/-/lru-cache-10.4.3.tgz",
+      "integrity": "sha512-JNAzZcXrCt42VGLuYz0zfAzDfAvJWW6AfYlDBQyDV5DClI2m5sAmK+OIO7s59XfsRsWHp02jAJrRadPRGTt6SQ==",
+      "dev": true,
+      "license": "ISC"
+    },
     "node_modules/magic-string": {
       "version": "0.30.21",
       "resolved": "https://registry.npmjs.org/magic-string/-/magic-string-0.30.21.tgz",
@@ -3256,6 +4125,16 @@
         "url": "https://github.com/sponsors/sindresorhus"
       }
     },
+    "node_modules/math-intrinsics": {
+      "version": "1.1.0",
+      "resolved": "https://registry.npmjs.org/math-intrinsics/-/math-intrinsics-1.1.0.tgz",
+      "integrity": "sha512-/IXtbwEk5HTPyEwyKX6hGkYXxM9nbj64B+ilVJnC/R6B0pH5G4V3b0pVbL7DBj4tkhBAppbQUlf6F6Xl9LHu1g==",
+      "dev": true,
+      "license": "MIT",
+      "engines": {
+        "node": ">= 0.4"
+      }
+    },
     "node_modules/merge-stream": {
       "version": "2.0.0",
       "resolved": "https://registry.npmjs.org/merge-stream/-/merge-stream-2.0.0.tgz",
@@ -3287,6 +4166,29 @@
         "node": ">=8.6"
       }
     },
+    "node_modules/mime-db": {
+      "version": "1.52.0",
+      "resolved": "https://registry.npmjs.org/mime-db/-/mime-db-1.52.0.tgz",
+      "integrity": "sha512-sPU4uV7dYlvtWJxwwxHD0PuihVNiE7TyAbQ5SWxDCB9mUYvOgroQOwYQQOKPJ8CIbE+1ETVlOoK1UC2nU3gYvg==",
+      "dev": true,
+      "license": "MIT",
+      "engines": {
+        "node": ">= 0.6"
+      }
+    },
+    "node_modules/mime-types": {
+      "version": "2.1.35",
+      "resolved": "https://registry.npmjs.org/mime-types/-/mime-types-2.1.35.tgz",
+      "integrity": "sha512-ZDY+bPm5zTTF+YpCrAU9nK0UgICYPT0QtT1NZWFv4s++TNkcgVaT0g6+4R2uI4MjQjzysHB1zxuWL50hzaeXiw==",
+      "dev": true,
+      "license": "MIT",
+      "dependencies": {
+        "mime-db": "1.52.0"
+      },
+      "engines": {
+        "node": ">= 0.6"
+      }
+    },
     "node_modules/mimic-fn": {
       "version": "4.0.0",
       "resolved": "https://registry.npmjs.org/mimic-fn/-/mimic-fn-4.0.0.tgz",
@@ -3416,6 +4318,23 @@
         "url": "https://github.com/sponsors/sindresorhus"
       }
     },
+    "node_modules/nwsapi": {
+      "version": "2.2.23",
+      "resolved": "https://registry.npmjs.org/nwsapi/-/nwsapi-2.2.23.tgz",
+      "integrity": "sha512-7wfH4sLbt4M0gCDzGE6vzQBo0bfTKjU7Sfpqy/7gs1qBfYz2vEJH6vXcBKpO3+6Yu1telwd0t9HpyOoLEQQbIQ==",
+      "dev": true,
+      "license": "MIT"
+    },
+    "node_modules/object-assign": {
+      "version": "4.1.1",
+      "resolved": "https://registry.npmjs.org/object-assign/-/object-assign-4.1.1.tgz",
+      "integrity": "sha512-rJgTQnkUnH1sFw8yT6VSU3zD3sWmu6sZhIseY8VX+GRu3P6F7Fu+JNDoXfklElbLJSnc3FUQHVe4cU5hj+BcUg==",
+      "dev": true,
+      "license": "MIT",
+      "engines": {
+        "node": ">=0.10.0"
+      }
+    },
     "node_modules/on-exit-leak-free": {
       "version": "2.1.2",
       "resolved": "https://registry.npmjs.org/on-exit-leak-free/-/on-exit-leak-free-2.1.2.tgz",
@@ -3513,6 +4432,19 @@
         "node": ">=6"
       }
     },
+    "node_modules/parse5": {
+      "version": "7.3.0",
+      "resolved": "https://registry.npmjs.org/parse5/-/parse5-7.3.0.tgz",
+      "integrity": "sha512-IInvU7fabl34qmi9gY8XOVxhYyMyuH2xUNpb2q8/Y+7552KlejkRvqvD19nMoUW/uQGGbqNpA6Tufu5FL5BZgw==",
+      "dev": true,
+      "license": "MIT",
+      "dependencies": {
+        "entities": "^6.0.0"
+      },
+      "funding": {
+        "url": "https://github.com/inikulin/parse5?sponsor=1"
+      }
+    },
     "node_modules/path-exists": {
       "version": "4.0.0",
       "resolved": "https://registry.npmjs.org/path-exists/-/path-exists-4.0.0.tgz",
@@ -3768,6 +4700,25 @@
       "integrity": "sha512-mqn0kFRl0EoqhnL0GQ0veqFHyIN1yig9RHh/InzORTUiZHFRAur+aMtRkELNwGs9aNwKS6tg/An4NYBPGwvtzQ==",
       "license": "MIT"
     },
+    "node_modules/prop-types": {
+      "version": "15.8.1",
+      "resolved": "https://registry.npmjs.org/prop-types/-/prop-types-15.8.1.tgz",
+      "integrity": "sha512-oj87CgZICdulUohogVAR7AjlC0327U4el4L6eAvOqCeudMDVU0NThNaV+b9Df4dXgSP1gXMTnPdhfe/2qDH5cg==",
+      "dev": true,
+      "license": "MIT",
+      "dependencies": {
+        "loose-envify": "^1.4.0",
+        "object-assign": "^4.1.1",
+        "react-is": "^16.13.1"
+      }
+    },
+    "node_modules/prop-types/node_modules/react-is": {
+      "version": "16.13.1",
+      "resolved": "https://registry.npmjs.org/react-is/-/react-is-16.13.1.tgz",
+      "integrity": "sha512-24e6ynE2H+OKt4kqsOvNd8kBpV65zoxbA4BVsEOB3ARVWQki/DHzaUoC5KuON/BiccDaCCTZBuOcfZs70kR8bQ==",
+      "dev": true,
+      "license": "MIT"
+    },
     "node_modules/proxy-addr": {
       "version": "2.0.7",
       "resolved": "https://registry.npmjs.org/proxy-addr/-/proxy-addr-2.0.7.tgz",
@@ -3781,6 +4732,19 @@
         "node": ">= 0.10"
       }
     },
+    "node_modules/psl": {
+      "version": "1.15.0",
+      "resolved": "https://registry.npmjs.org/psl/-/psl-1.15.0.tgz",
+      "integrity": "sha512-JZd3gMVBAVQkSs6HdNZo9Sdo0LNcQeMNP3CozBJb3JYC/QUYZTnKxP+f8oWRX4rHP5EurWxqAHTSwUCjlNKa1w==",
+      "dev": true,
+      "license": "MIT",
+      "dependencies": {
+        "punycode": "^2.3.1"
+      },
+      "funding": {
+        "url": "https://github.com/sponsors/lupomontero"
+      }
+    },
     "node_modules/pump": {
       "version": "3.0.4",
       "resolved": "https://registry.npmjs.org/pump/-/pump-3.0.4.tgz",
@@ -3801,6 +4765,13 @@
         "node": ">=6"
       }
     },
+    "node_modules/querystringify": {
+      "version": "2.2.0",
+      "resolved": "https://registry.npmjs.org/querystringify/-/querystringify-2.2.0.tgz",
+      "integrity": "sha512-FIqgj2EUvTa7R50u0rGsyTftzjYmv/a3hO345bZNrqabNqjtgiDMgmo4mkUjd+nzU5oF3dClKqFIPUKybUyqoQ==",
+      "dev": true,
+      "license": "MIT"
+    },
     "node_modules/queue-microtask": {
       "version": "1.2.3",
       "resolved": "https://registry.npmjs.org/queue-microtask/-/queue-microtask-1.2.3.tgz",
@@ -3828,6 +4799,33 @@
       "integrity": "sha512-tYC1Q1hgyRuHgloV/YXs2w15unPVh8qfu/qCTfhTYamaw7fyhumKa2yGpdSo87vY32rIclj+4fWYQXUMs9EHvg==",
       "license": "MIT"
     },
+    "node_modules/react": {
+      "version": "18.3.1",
+      "resolved": "https://registry.npmjs.org/react/-/react-18.3.1.tgz",
+      "integrity": "sha512-wS+hAgJShR0KhEvPJArfuPVN1+Hz1t0Y6n5jLrGQbkb4urgPE/0Rve+1kMB1v/oWgHgm4WIcV+i7F2pTVj+2iQ==",
+      "dev": true,
+      "license": "MIT",
+      "dependencies": {
+        "loose-envify": "^1.1.0"
+      },
+      "engines": {
+        "node": ">=0.10.0"
+      }
+    },
+    "node_modules/react-dom": {
+      "version": "18.3.1",
+      "resolved": "https://registry.npmjs.org/react-dom/-/react-dom-18.3.1.tgz",
+      "integrity": "sha512-5m4nQKp+rZRb09LNH59GM4BxTh9251/ylbKIbpe7TpGxfJ+9kv6BLkLBXIjjspbgbnIBNqlI23tRnTWT0snUIw==",
+      "dev": true,
+      "license": "MIT",
+      "dependencies": {
+        "loose-envify": "^1.1.0",
+        "scheduler": "^0.23.2"
+      },
+      "peerDependencies": {
+        "react": "^18.3.1"
+      }
+    },
     "node_modules/react-is": {
       "version": "18.3.1",
       "resolved": "https://registry.npmjs.org/react-is/-/react-is-18.3.1.tgz",
@@ -3835,6 +4833,39 @@
       "dev": true,
       "license": "MIT"
     },
+    "node_modules/react-smooth": {
+      "version": "4.0.4",
+      "resolved": "https://registry.npmjs.org/react-smooth/-/react-smooth-4.0.4.tgz",
+      "integrity": "sha512-gnGKTpYwqL0Iii09gHobNolvX4Kiq4PKx6eWBCYYix+8cdw+cGo3do906l1NBPKkSWx1DghC1dlWG9L2uGd61Q==",
+      "dev": true,
+      "license": "MIT",
+      "dependencies": {
+        "fast-equals": "^5.0.1",
+        "prop-types": "^15.8.1",
+        "react-transition-group": "^4.4.5"
+      },
+      "peerDependencies": {
+        "react": "^16.8.0 || ^17.0.0 || ^18.0.0 || ^19.0.0",
+        "react-dom": "^16.8.0 || ^17.0.0 || ^18.0.0 || ^19.0.0"
+      }
+    },
+    "node_modules/react-transition-group": {
+      "version": "4.4.5",
+      "resolved": "https://registry.npmjs.org/react-transition-group/-/react-transition-group-4.4.5.tgz",
+      "integrity": "sha512-pZcd1MCJoiKiBR2NRxeCRg13uCXbydPnmB4EOeRrY7480qNWO8IIgQG6zlDkm6uRMsURXPuKq0GWtiM59a5Q6g==",
+      "dev": true,
+      "license": "BSD-3-Clause",
+      "dependencies": {
+        "@babel/runtime": "^7.5.5",
+        "dom-helpers": "^5.0.1",
+        "loose-envify": "^1.4.0",
+        "prop-types": "^15.6.2"
+      },
+      "peerDependencies": {
+        "react": ">=16.6.0",
+        "react-dom": ">=16.6.0"
+      }
+    },
     "node_modules/readable-stream": {
       "version": "4.7.0",
       "resolved": "https://registry.npmjs.org/readable-stream/-/readable-stream-4.7.0.tgz",
@@ -3872,6 +4903,40 @@
         "node": ">= 12.13.0"
       }
     },
+    "node_modules/recharts": {
+      "version": "2.15.4",
+      "resolved": "https://registry.npmjs.org/recharts/-/recharts-2.15.4.tgz",
+      "integrity": "sha512-UT/q6fwS3c1dHbXv2uFgYJ9BMFHu3fwnd7AYZaEQhXuYQ4hgsxLvsUXzGdKeZrW5xopzDCvuA2N41WJ88I7zIw==",
+      "dev": true,
+      "license": "MIT",
+      "dependencies": {
+        "clsx": "^2.0.0",
+        "eventemitter3": "^4.0.1",
+        "lodash": "^4.17.21",
+        "react-is": "^18.3.1",
+        "react-smooth": "^4.0.4",
+        "recharts-scale": "^0.4.4",
+        "tiny-invariant": "^1.3.1",
+        "victory-vendor": "^36.6.8"
+      },
+      "engines": {
+        "node": ">=14"
+      },
+      "peerDependencies": {
+        "react": "^16.0.0 || ^17.0.0 || ^18.0.0 || ^19.0.0",
+        "react-dom": "^16.0.0 || ^17.0.0 || ^18.0.0 || ^19.0.0"
+      }
+    },
+    "node_modules/recharts-scale": {
+      "version": "0.4.5",
+      "resolved": "https://registry.npmjs.org/recharts-scale/-/recharts-scale-0.4.5.tgz",
+      "integrity": "sha512-kivNFO+0OcUNu7jQquLXAxz1FIwZj8nrj+YkOKc5694NbjCvcT6aSZiIzNzd2Kul4o4rTto8QVR9lMNtxD4G1w==",
+      "dev": true,
+      "license": "MIT",
+      "dependencies": {
+        "decimal.js-light": "^2.4.1"
+      }
+    },
     "node_modules/require-from-string": {
       "version": "2.0.2",
       "resolved": "https://registry.npmjs.org/require-from-string/-/require-from-string-2.0.2.tgz",
@@ -3881,6 +4946,13 @@
         "node": ">=0.10.0"
       }
     },
+    "node_modules/requires-port": {
+      "version": "1.0.0",
+      "resolved": "https://registry.npmjs.org/requires-port/-/requires-port-1.0.0.tgz",
+      "integrity": "sha512-KigOCHcocU3XODJxsu8i/j8T9tzT4adHiecwORRQ0ZZFcp7ahwXuRU1m+yuO90C5ZUyGeGfocHDI14M3L3yDAQ==",
+      "dev": true,
+      "license": "MIT"
+    },
     "node_modules/resolve-from": {
       "version": "4.0.0",
       "resolved": "https://registry.npmjs.org/resolve-from/-/resolve-from-4.0.0.tgz",
@@ -3978,6 +5050,13 @@
         "fsevents": "~2.3.2"
       }
     },
+    "node_modules/rrweb-cssom": {
+      "version": "0.7.1",
+      "resolved": "https://registry.npmjs.org/rrweb-cssom/-/rrweb-cssom-0.7.1.tgz",
+      "integrity": "sha512-TrEMa7JGdVm0UThDJSx7ddw5nVm3UJS9o9CCIZ72B1vSyEZoziDqBYP3XIoi/12lKrJR8rE3jeFHMok2F/Mnsg==",
+      "dev": true,
+      "license": "MIT"
+    },
     "node_modules/run-parallel": {
       "version": "1.2.0",
       "resolved": "https://registry.npmjs.org/run-parallel/-/run-parallel-1.2.0.tgz",
@@ -4040,6 +5119,36 @@
         "node": ">=10"
       }
     },
+    "node_modules/safer-buffer": {
+      "version": "2.1.2",
+      "resolved": "https://registry.npmjs.org/safer-buffer/-/safer-buffer-2.1.2.tgz",
+      "integrity": "sha512-YZo3K82SD7Riyi0E1EQPojLz7kpepnSQI9IyPbHHg1XXXevb5dJI7tpyN2ADxGcQbHG7vcyRHk0cbwqcQriUtg==",
+      "dev": true,
+      "license": "MIT"
+    },
+    "node_modules/saxes": {
+      "version": "6.0.0",
+      "resolved": "https://registry.npmjs.org/saxes/-/saxes-6.0.0.tgz",
+      "integrity": "sha512-xAg7SOnEhrm5zI3puOOKyy1OMcMlIJZYNJY7xLBwSze0UjhPLnWfj2GF2EpT0jmzaJKIWKHLsaSSajf35bcYnA==",
+      "dev": true,
+      "license": "ISC",
+      "dependencies": {
+        "xmlchars": "^2.2.0"
+      },
+      "engines": {
+        "node": ">=v12.22.7"
+      }
+    },
+    "node_modules/scheduler": {
+      "version": "0.23.2",
+      "resolved": "https://registry.npmjs.org/scheduler/-/scheduler-0.23.2.tgz",
+      "integrity": "sha512-UOShsPwz7NrMUqhR6t0hWjFduvOzbtv7toDH1/hIrfRNIDBnnBWd0CwJTGvTpngVlmwGCdP9/Zl/tVrDqcuYzQ==",
+      "dev": true,
+      "license": "MIT",
+      "dependencies": {
+        "loose-envify": "^1.1.0"
+      }
+    },
     "node_modules/secure-json-parse": {
       "version": "2.7.0",
       "resolved": "https://registry.npmjs.org/secure-json-parse/-/secure-json-parse-2.7.0.tgz",
@@ -4232,6 +5341,13 @@
         "node": ">=8"
       }
     },
+    "node_modules/symbol-tree": {
+      "version": "3.2.4",
+      "resolved": "https://registry.npmjs.org/symbol-tree/-/symbol-tree-3.2.4.tgz",
+      "integrity": "sha512-9QNk5KwDF+Bvz+PyObkmSYjI5ksVUYtjW7AU22r2NKcfLJcXp96hkDWU3+XndOsUb+AQ9QhfzfCT2O+CNWT5Tw==",
+      "dev": true,
+      "license": "MIT"
+    },
     "node_modules/test-exclude": {
       "version": "6.0.0",
       "resolved": "https://registry.npmjs.org/test-exclude/-/test-exclude-6.0.0.tgz",
@@ -4287,6 +5403,13 @@
         "real-require": "^0.2.0"
       }
     },
+    "node_modules/tiny-invariant": {
+      "version": "1.3.3",
+      "resolved": "https://registry.npmjs.org/tiny-invariant/-/tiny-invariant-1.3.3.tgz",
+      "integrity": "sha512-+FbBPE1o9QAYvviau/qC5SE3caw21q3xkvWKBtja5vgqOWIHHJ3ioaq1VPfn/Szqctz2bU/oYeKd9/z5BL+PVg==",
+      "dev": true,
+      "license": "MIT"
+    },
     "node_modules/tinybench": {
       "version": "2.9.0",
       "resolved": "https://registry.npmjs.org/tinybench/-/tinybench-2.9.0.tgz",
@@ -4335,6 +5458,35 @@
         "node": ">=12"
       }
     },
+    "node_modules/tough-cookie": {
+      "version": "4.1.4",
+      "resolved": "https://registry.npmjs.org/tough-cookie/-/tough-cookie-4.1.4.tgz",
+      "integrity": "sha512-Loo5UUvLD9ScZ6jh8beX1T6sO1w2/MpCRpEP7V280GKMVUQ0Jzar2U3UJPsrdbziLEMMhu3Ujnq//rhiFuIeag==",
+      "dev": true,
+      "license": "BSD-3-Clause",
+      "dependencies": {
+        "psl": "^1.1.33",
+        "punycode": "^2.1.1",
+        "universalify": "^0.2.0",
+        "url-parse": "^1.5.3"
+      },
+      "engines": {
+        "node": ">=6"
+      }
+    },
+    "node_modules/tr46": {
+      "version": "5.1.1",
+      "resolved": "https://registry.npmjs.org/tr46/-/tr46-5.1.1.tgz",
+      "integrity": "sha512-hdF5ZgjTqgAntKkklYw0R03MG2x/bSzTtkxmIRw/sTNV8YXsCJ1tfLAX23lhxhHJlEf3CRCOCGGWw3vI3GaSPw==",
+      "dev": true,
+      "license": "MIT",
+      "dependencies": {
+        "punycode": "^2.3.1"
+      },
+      "engines": {
+        "node": ">=18"
+      }
+    },
     "node_modules/ts-api-utils": {
       "version": "1.4.3",
       "resolved": "https://registry.npmjs.org/ts-api-utils/-/ts-api-utils-1.4.3.tgz",
@@ -4421,6 +5573,16 @@
       "dev": true,
       "license": "MIT"
     },
+    "node_modules/universalify": {
+      "version": "0.2.0",
+      "resolved": "https://registry.npmjs.org/universalify/-/universalify-0.2.0.tgz",
+      "integrity": "sha512-CJ1QgKmNg3CwvAv/kOFmtnEN05f0D/cn9QntgNOQlQF9dgvVTHj3t+8JPdjqawCHk7V/KA+fbUqzZ9XWhcqPUg==",
+      "dev": true,
+      "license": "MIT",
+      "engines": {
+        "node": ">= 4.0.0"
+      }
+    },
     "node_modules/uri-js": {
       "version": "4.4.1",
       "resolved": "https://registry.npmjs.org/uri-js/-/uri-js-4.4.1.tgz",
@@ -4431,6 +5593,40 @@
         "punycode": "^2.1.0"
       }
     },
+    "node_modules/url-parse": {
+      "version": "1.5.10",
+      "resolved": "https://registry.npmjs.org/url-parse/-/url-parse-1.5.10.tgz",
+      "integrity": "sha512-WypcfiRhfeUP9vvF0j6rw0J3hrWrw6iZv3+22h6iRMJ/8z1Tj6XfLP4DsUix5MhMPnXpiHDoKyoZ/bdCkwBCiQ==",
+      "dev": true,
+      "license": "MIT",
+      "dependencies": {
+        "querystringify": "^2.1.1",
+        "requires-port": "^1.0.0"
+      }
+    },
+    "node_modules/victory-vendor": {
+      "version": "36.9.2",
+      "resolved": "https://registry.npmjs.org/victory-vendor/-/victory-vendor-36.9.2.tgz",
+      "integrity": "sha512-PnpQQMuxlwYdocC8fIJqVXvkeViHYzotI+NJrCuav0ZYFoq912ZHBk3mCeuj+5/VpodOjPe1z0Fk2ihgzlXqjQ==",
+      "dev": true,
+      "license": "MIT AND ISC",
+      "dependencies": {
+        "@types/d3-array": "^3.0.3",
+        "@types/d3-ease": "^3.0.0",
+        "@types/d3-interpolate": "^3.0.1",
+        "@types/d3-scale": "^4.0.2",
+        "@types/d3-shape": "^3.1.0",
+        "@types/d3-time": "^3.0.0",
+        "@types/d3-timer": "^3.0.0",
+        "d3-array": "^3.1.6",
+        "d3-ease": "^3.0.1",
+        "d3-interpolate": "^3.0.1",
+        "d3-scale": "^4.0.2",
+        "d3-shape": "^3.1.0",
+        "d3-time": "^3.0.0",
+        "d3-timer": "^3.0.1"
+      }
+    },
     "node_modules/vite": {
       "version": "5.4.21",
       "resolved": "https://registry.npmjs.org/vite/-/vite-5.4.21.tgz",
@@ -4580,6 +5776,67 @@
         }
       }
     },
+    "node_modules/w3c-xmlserializer": {
+      "version": "5.0.0",
+      "resolved": "https://registry.npmjs.org/w3c-xmlserializer/-/w3c-xmlserializer-5.0.0.tgz",
+      "integrity": "sha512-o8qghlI8NZHU1lLPrpi2+Uq7abh4GGPpYANlalzWxyWteJOCsr/P+oPBA49TOLu5FTZO4d3F9MnWJfiMo4BkmA==",
+      "dev": true,
+      "license": "MIT",
+      "dependencies": {
+        "xml-name-validator": "^5.0.0"
+      },
+      "engines": {
+        "node": ">=18"
+      }
+    },
+    "node_modules/webidl-conversions": {
+      "version": "7.0.0",
+      "resolved": "https://registry.npmjs.org/webidl-conversions/-/webidl-conversions-7.0.0.tgz",
+      "integrity": "sha512-VwddBukDzu71offAQR975unBIGqfKZpM+8ZX6ySk8nYhVoo5CYaZyzt3YBvYtRtO+aoGlqxPg/B87NGVZ/fu6g==",
+      "dev": true,
+      "license": "BSD-2-Clause",
+      "engines": {
+        "node": ">=12"
+      }
+    },
+    "node_modules/whatwg-encoding": {
+      "version": "3.1.1",
+      "resolved": "https://registry.npmjs.org/whatwg-encoding/-/whatwg-encoding-3.1.1.tgz",
+      "integrity": "sha512-6qN4hJdMwfYBtE3YBTTHhoeuUrDBPZmbQaxWAqSALV/MeEnR5z1xd8UKud2RAkFoPkmB+hli1TZSnyi84xz1vQ==",
+      "deprecated": "Use @exodus/bytes instead for a more spec-conformant and faster implementation",
+      "dev": true,
+      "license": "MIT",
+      "dependencies": {
+        "iconv-lite": "0.6.3"
+      },
+      "engines": {
+        "node": ">=18"
+      }
+    },
+    "node_modules/whatwg-mimetype": {
+      "version": "4.0.0",
+      "resolved": "https://registry.npmjs.org/whatwg-mimetype/-/whatwg-mimetype-4.0.0.tgz",
+      "integrity": "sha512-QaKxh0eNIi2mE9p2vEdzfagOKHCcj1pJ56EEHGQOVxp8r9/iszLUUV7v89x9O1p/T+NlTM5W7jW6+cz4Fq1YVg==",
+      "dev": true,
+      "license": "MIT",
+      "engines": {
+        "node": ">=18"
+      }
+    },
+    "node_modules/whatwg-url": {
+      "version": "14.2.0",
+      "resolved": "https://registry.npmjs.org/whatwg-url/-/whatwg-url-14.2.0.tgz",
+      "integrity": "sha512-De72GdQZzNTUBBChsXueQUnPKDkg/5A5zp7pFDuQAj5UFoENpiACU0wlCvzpAGnTkj++ihpKwKyYewn/XNUbKw==",
+      "dev": true,
+      "license": "MIT",
+      "dependencies": {
+        "tr46": "^5.1.0",
+        "webidl-conversions": "^7.0.0"
+      },
+      "engines": {
+        "node": ">=18"
+      }
+    },
     "node_modules/which": {
       "version": "2.0.2",
       "resolved": "https://registry.npmjs.org/which/-/which-2.0.2.tgz",
@@ -4629,6 +5886,45 @@
       "integrity": "sha512-l4Sp/DRseor9wL6EvV2+TuQn63dMkPjZ/sp9XkghTEbV9KlPS1xUsZ3u7/IQO4wxtcFB4bgpQPRcR3QCvezPcQ==",
       "license": "ISC"
     },
+    "node_modules/ws": {
+      "version": "8.20.0",
+      "resolved": "https://registry.npmjs.org/ws/-/ws-8.20.0.tgz",
+      "integrity": "sha512-sAt8BhgNbzCtgGbt2OxmpuryO63ZoDk/sqaB/znQm94T4fCEsy/yV+7CdC1kJhOU9lboAEU7R3kquuycDoibVA==",
+      "dev": true,
+      "license": "MIT",
+      "engines": {
+        "node": ">=10.0.0"
+      },
+      "peerDependencies": {
+        "bufferutil": "^4.0.1",
+        "utf-8-validate": ">=5.0.2"
+      },
+      "peerDependenciesMeta": {
+        "bufferutil": {
+          "optional": true
+        },
+        "utf-8-validate": {
+          "optional": true
+        }
+      }
+    },
+    "node_modules/xml-name-validator": {
+      "version": "5.0.0",
+      "resolved": "https://registry.npmjs.org/xml-name-validator/-/xml-name-validator-5.0.0.tgz",
+      "integrity": "sha512-EvGK8EJ3DhaHfbRlETOWAS5pO9MZITeauHKJyb8wyajUfQUenkIg2MvLDTZ4T/TgIcm3HU0TFBgWWboAZ30UHg==",
+      "dev": true,
+      "license": "Apache-2.0",
+      "engines": {
+        "node": ">=18"
+      }
+    },
+    "node_modules/xmlchars": {
+      "version": "2.2.0",
+      "resolved": "https://registry.npmjs.org/xmlchars/-/xmlchars-2.2.0.tgz",
+      "integrity": "sha512-JZnDKK8B0RCDw84FNdDAIpZK+JuJw+s7Lz8nksI7SIuU3UXJJslUthsi+uWBUYOwPFwW7W7PRLRfUKpxjtjFCw==",
+      "dev": true,
+      "license": "MIT"
+    },
     "node_modules/yocto-queue": {
       "version": "0.1.0",
       "resolved": "https://registry.npmjs.org/yocto-queue/-/yocto-queue-0.1.0.tgz",
diff --git a/package.json b/package.json
index b15c60b..b2dbf6b 100644
--- a/package.json
+++ b/package.json
@@ -23,7 +23,8 @@
     "lint": "eslint .",
     "test": "vitest run",
     "test:watch": "vitest",
-    "test:all": "npm run lint && npm run typecheck && npm run test"
+    "test:all": "npm run lint && npm run typecheck && npm run test",
+    "build:dashboard": "cd src/dashboard/frontend && npm ci && npm run build"
   },
   "dependencies": {
     "chokidar": "^3.6.0",
@@ -44,6 +45,12 @@
     "@vitest/coverage-v8": "^1.6.0",
     "eslint": "^8.57.0",
     "typescript": "^5.5.4",
-    "vitest": "^1.6.0"
+    "vitest": "^1.6.0",
+    "@types/react": "^18.3.3",
+    "@types/react-dom": "^18.3.0",
+    "jsdom": "^24.1.1",
+    "react": "^18.3.1",
+    "react-dom": "^18.3.1",
+    "recharts": "^2.12.7"
   }
 }
diff --git a/src/dashboard/frontend/index.html b/src/dashboard/frontend/index.html
new file mode 100644
index 0000000..1c1b27c
--- /dev/null
+++ b/src/dashboard/frontend/index.html
@@ -0,0 +1,12 @@
+<!DOCTYPE html>
+<html lang="en">
+<head>
+  <meta charset="UTF-8" />
+  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
+  <title>ccmux Dashboard</title>
+</head>
+<body>
+  <div id="root"></div>
+  <script type="module" src="./src/main.tsx"></script>
+</body>
+</html>
diff --git a/src/dashboard/frontend/package.json b/src/dashboard/frontend/package.json
new file mode 100644
index 0000000..d399c99
--- /dev/null
+++ b/src/dashboard/frontend/package.json
@@ -0,0 +1,23 @@
+{
+  "name": "ccmux-dashboard",
+  "version": "0.0.0",
+  "private": true,
+  "type": "module",
+  "scripts": {
+    "dev": "vite",
+    "build": "tsc --noEmit && vite build",
+    "preview": "vite preview"
+  },
+  "dependencies": {
+    "react": "^18.3.1",
+    "react-dom": "^18.3.1",
+    "recharts": "^2.12.7"
+  },
+  "devDependencies": {
+    "@types/react": "^18.3.3",
+    "@types/react-dom": "^18.3.0",
+    "@vitejs/plugin-react": "^4.3.1",
+    "typescript": "^5.5.4",
+    "vite": "^5.4.2"
+  }
+}
diff --git a/src/dashboard/frontend/src/App.tsx b/src/dashboard/frontend/src/App.tsx
new file mode 100644
index 0000000..53e2c57
--- /dev/null
+++ b/src/dashboard/frontend/src/App.tsx
@@ -0,0 +1,45 @@
+import { useState, useEffect } from 'react';
+import type { SummaryResponse } from './api/types';
+import { getSummary } from './api/client';
+import SummaryPanel from './components/SummaryPanel';
+import DecisionsTable from './components/DecisionsTable';
+import CostChart from './components/CostChart';
+
+type Tab = 'summary' | 'decisions' | 'costs';
+
+export default function App() {
+  const [tab, setTab] = useState<Tab>('summary');
+  const [summary, setSummary] = useState<SummaryResponse | null>(null);
+  const [error, setError] = useState<string | null>(null);
+
+  useEffect(() => {
+    getSummary()
+      .then(setSummary)
+      .catch((e: Error) => setError(e.message));
+  }, []);
+
+  return (
+    <div className="app">
+      <header>
+        <h1>ccmux Dashboard</h1>
+        <nav>
+          {(['summary', 'decisions', 'costs'] as const).map((t) => (
+            <button
+              key={t}
+              className={tab === t ? 'active' : ''}
+              onClick={() => setTab(t)}
+            >
+              {t.charAt(0).toUpperCase() + t.slice(1)}
+            </button>
+          ))}
+        </nav>
+      </header>
+      <main>
+        {error && <div className="error">{error}</div>}
+        {tab === 'summary' && <SummaryPanel data={summary} />}
+        {tab === 'decisions' && <DecisionsTable />}
+        {tab === 'costs' && <CostChart />}
+      </main>
+    </div>
+  );
+}
diff --git a/src/dashboard/frontend/src/api/client.ts b/src/dashboard/frontend/src/api/client.ts
new file mode 100644
index 0000000..c8b1d3f
--- /dev/null
+++ b/src/dashboard/frontend/src/api/client.ts
@@ -0,0 +1,31 @@
+import type { SummaryResponse, DecisionsResponse, CostsResponse } from './types.js';
+
+async function fetchJson<T>(path: string): Promise<T> {
+  const res = await fetch(path);
+  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
+  return res.json() as Promise<T>;
+}
+
+export function getSummary(): Promise<SummaryResponse> {
+  return fetchJson<SummaryResponse>('/api/summary');
+}
+
+export function getDecisions(
+  params: { limit?: number; since?: string; offset?: number } = {},
+): Promise<DecisionsResponse> {
+  const search = new URLSearchParams();
+  if (params.limit !== undefined) search.set('limit', String(params.limit));
+  if (params.since !== undefined) search.set('since', params.since);
+  if (params.offset !== undefined) search.set('offset', String(params.offset));
+  const qs = search.toString();
+  return fetchJson<DecisionsResponse>(`/api/decisions${qs ? '?' + qs : ''}`);
+}
+
+export function getCosts(
+  params: { bucket?: 'hour' | 'day' } = {},
+): Promise<CostsResponse> {
+  const search = new URLSearchParams();
+  if (params.bucket) search.set('bucket', params.bucket);
+  const qs = search.toString();
+  return fetchJson<CostsResponse>(`/api/costs${qs ? '?' + qs : ''}`);
+}
diff --git a/src/dashboard/frontend/src/api/types.ts b/src/dashboard/frontend/src/api/types.ts
new file mode 100644
index 0000000..9dcf96c
--- /dev/null
+++ b/src/dashboard/frontend/src/api/types.ts
@@ -0,0 +1,58 @@
+export interface SummaryResponse {
+  readonly routingDistribution: Record<string, number>;
+  readonly cacheHitRate: number;
+  readonly latency: { readonly p50: number; readonly p95: number; readonly p99: number };
+  readonly totalCost: number;
+  readonly classifierCost: number;
+  readonly truncated?: boolean;
+}
+
+export interface DecisionRow {
+  readonly decision_id: string;
+  readonly timestamp: string;
+  readonly session_id: string;
+  readonly request_hash: string;
+  readonly requested_model: string;
+  readonly forwarded_model: string;
+  readonly chosen_by: string;
+  readonly upstream_latency_ms: number;
+  readonly cost_estimate_usd: number | null;
+  readonly classifier_cost_usd: number | null;
+  readonly policy_result: {
+    readonly rule_id: string | null;
+    readonly action: string;
+    readonly target_model: string;
+  };
+  readonly classifier_result: {
+    readonly score: number;
+    readonly suggested: string;
+    readonly confidence: number;
+    readonly source: 'heuristic' | 'haiku';
+    readonly latencyMs: number;
+  } | null;
+  readonly usage: {
+    readonly input_tokens: number;
+    readonly output_tokens: number;
+    readonly cache_read_input_tokens: number;
+    readonly cache_creation_input_tokens: number;
+  } | null;
+}
+
+export interface DecisionsResponse {
+  readonly items: readonly DecisionRow[];
+  readonly limit: number;
+  readonly offset: number;
+  readonly total_scanned: number;
+}
+
+export interface CostBucket {
+  readonly ts_bucket: string;
+  readonly cost_usd: number;
+  readonly classifier_cost_usd: number;
+  readonly requests: number;
+}
+
+export interface CostsResponse {
+  readonly buckets: readonly CostBucket[];
+  readonly truncated?: boolean;
+}
diff --git a/src/dashboard/frontend/src/components/CostChart.tsx b/src/dashboard/frontend/src/components/CostChart.tsx
new file mode 100644
index 0000000..3f389a8
--- /dev/null
+++ b/src/dashboard/frontend/src/components/CostChart.tsx
@@ -0,0 +1,56 @@
+import { useState, useEffect } from 'react';
+import {
+  BarChart, Bar, XAxis, YAxis, Tooltip, Legend,
+  ResponsiveContainer,
+} from 'recharts';
+import type { CostBucket } from '../api/types';
+import { getCosts } from '../api/client';
+
+export default function CostChart() {
+  const [buckets, setBuckets] = useState<CostBucket[]>([]);
+  const [showClassifier, setShowClassifier] = useState(true);
+  const [loading, setLoading] = useState(true);
+
+  useEffect(() => {
+    getCosts({ bucket: 'hour' })
+      .then((res) => setBuckets([...res.buckets]))
+      .catch(() => setBuckets([]))
+      .finally(() => setLoading(false));
+  }, []);
+
+  if (loading) return <div className="loading">Loading costs...</div>;
+
+  const chartData = buckets.map((b) => ({
+    time: new Date(b.ts_bucket).toLocaleTimeString(),
+    cost: b.cost_usd,
+    classifier: b.classifier_cost_usd,
+    requests: b.requests,
+  }));
+
+  return (
+    <div className="cost-chart">
+      <div className="controls">
+        <label>
+          <input
+            type="checkbox"
+            checked={showClassifier}
+            onChange={(e) => setShowClassifier(e.target.checked)}
+          />
+          Show classifier overhead
+        </label>
+      </div>
+      <ResponsiveContainer width="100%" height={400}>
+        <BarChart data={chartData}>
+          <XAxis dataKey="time" />
+          <YAxis />
+          <Tooltip />
+          <Legend />
+          <Bar dataKey="cost" name="Forwarding Cost" fill="#8884d8" />
+          {showClassifier && (
+            <Bar dataKey="classifier" name="Classifier Cost" fill="#ff7300" />
+          )}
+        </BarChart>
+      </ResponsiveContainer>
+    </div>
+  );
+}
diff --git a/src/dashboard/frontend/src/components/DecisionsTable.tsx b/src/dashboard/frontend/src/components/DecisionsTable.tsx
new file mode 100644
index 0000000..ae1da7a
--- /dev/null
+++ b/src/dashboard/frontend/src/components/DecisionsTable.tsx
@@ -0,0 +1,75 @@
+import { useState, useEffect } from 'react';
+import type { DecisionRow } from '../api/types';
+import { getDecisions } from '../api/client';
+
+const DEFAULT_LIMIT = 100;
+const MAX_LIMIT = 1000;
+
+export default function DecisionsTable() {
+  const [rows, setRows] = useState<DecisionRow[]>([]);
+  const [limit] = useState(DEFAULT_LIMIT);
+  const [offset, setOffset] = useState(0);
+  const [totalScanned, setTotalScanned] = useState(0);
+  const [loading, setLoading] = useState(true);
+
+  useEffect(() => {
+    setLoading(true);
+    const clampedLimit = Math.min(limit, MAX_LIMIT);
+    getDecisions({ limit: clampedLimit, offset })
+      .then((res) => {
+        setRows([...res.items]);
+        setTotalScanned(res.total_scanned);
+      })
+      .catch(() => setRows([]))
+      .finally(() => setLoading(false));
+  }, [limit, offset]);
+
+  if (loading) return <div className="loading">Loading decisions...</div>;
+
+  return (
+    <div className="decisions-table">
+      <table>
+        <thead>
+          <tr>
+            <th>Time</th>
+            <th>Requested</th>
+            <th>Forwarded</th>
+            <th>Chosen By</th>
+            <th>Latency (ms)</th>
+            <th>Cost ($)</th>
+          </tr>
+        </thead>
+        <tbody>
+          {rows.map((row) => (
+            <tr key={row.decision_id}>
+              <td>{new Date(row.timestamp).toLocaleTimeString()}</td>
+              <td>{row.requested_model}</td>
+              <td>{row.forwarded_model}</td>
+              <td>{row.chosen_by}</td>
+              <td>{row.upstream_latency_ms}</td>
+              <td>{row.cost_estimate_usd?.toFixed(6) ?? '\u2014'}</td>
+            </tr>
+          ))}
+        </tbody>
+      </table>
+      <div className="pagination">
+        <button
+          disabled={offset === 0}
+          onClick={() => setOffset(Math.max(0, offset - limit))}
+        >
+          Previous
+        </button>
+        <span>
+          Showing {offset + 1}\u2013{offset + rows.length} (scanned{' '}
+          {totalScanned})
+        </span>
+        <button
+          disabled={rows.length < limit}
+          onClick={() => setOffset(offset + limit)}
+        >
+          Next
+        </button>
+      </div>
+    </div>
+  );
+}
diff --git a/src/dashboard/frontend/src/components/SummaryPanel.tsx b/src/dashboard/frontend/src/components/SummaryPanel.tsx
new file mode 100644
index 0000000..6663b8a
--- /dev/null
+++ b/src/dashboard/frontend/src/components/SummaryPanel.tsx
@@ -0,0 +1,81 @@
+import {
+  PieChart, Pie, Cell,
+  BarChart, Bar, XAxis, YAxis, Tooltip,
+  ResponsiveContainer,
+} from 'recharts';
+import type { SummaryResponse } from '../api/types';
+
+const COLORS = ['#8884d8', '#82ca9d', '#ffc658', '#ff7300', '#0088fe'];
+
+interface Props {
+  readonly data: SummaryResponse | null;
+}
+
+export default function SummaryPanel({ data }: Props) {
+  if (!data) return <div className="loading">Loading summary...</div>;
+
+  const pieData = Object.entries(data.routingDistribution).map(
+    ([name, value]) => ({ name, value }),
+  );
+  const latencyData = [
+    { name: 'p50', value: data.latency.p50 },
+    { name: 'p95', value: data.latency.p95 },
+    { name: 'p99', value: data.latency.p99 },
+  ];
+
+  return (
+    <div className="summary-panel">
+      <div className="stats-grid">
+        <div className="stat-card">
+          <h3>Cache Hit Rate</h3>
+          <span className="stat-value">
+            {(data.cacheHitRate * 100).toFixed(1)}%
+          </span>
+        </div>
+        <div className="stat-card">
+          <h3>Total Cost</h3>
+          <span className="stat-value">${data.totalCost.toFixed(4)}</span>
+        </div>
+        <div className="stat-card">
+          <h3>Classifier Cost</h3>
+          <span className="stat-value">${data.classifierCost.toFixed(4)}</span>
+        </div>
+      </div>
+
+      <div className="charts-row">
+        <div className="chart-container">
+          <h3>Routing Distribution</h3>
+          <ResponsiveContainer width="100%" height={250}>
+            <PieChart>
+              <Pie
+                data={pieData}
+                dataKey="value"
+                nameKey="name"
+                cx="50%"
+                cy="50%"
+                outerRadius={80}
+                label
+              >
+                {pieData.map((_, i) => (
+                  <Cell key={i} fill={COLORS[i % COLORS.length]} />
+                ))}
+              </Pie>
+              <Tooltip />
+            </PieChart>
+          </ResponsiveContainer>
+        </div>
+        <div className="chart-container">
+          <h3>Latency Percentiles (ms)</h3>
+          <ResponsiveContainer width="100%" height={250}>
+            <BarChart data={latencyData}>
+              <XAxis dataKey="name" />
+              <YAxis />
+              <Tooltip />
+              <Bar dataKey="value" fill="#8884d8" />
+            </BarChart>
+          </ResponsiveContainer>
+        </div>
+      </div>
+    </div>
+  );
+}
diff --git a/src/dashboard/frontend/src/main.tsx b/src/dashboard/frontend/src/main.tsx
new file mode 100644
index 0000000..8f7da6f
--- /dev/null
+++ b/src/dashboard/frontend/src/main.tsx
@@ -0,0 +1,10 @@
+import React from 'react';
+import ReactDOM from 'react-dom/client';
+import App from './App';
+import './styles.css';
+
+ReactDOM.createRoot(document.getElementById('root')!).render(
+  <React.StrictMode>
+    <App />
+  </React.StrictMode>,
+);
diff --git a/src/dashboard/frontend/src/styles.css b/src/dashboard/frontend/src/styles.css
new file mode 100644
index 0000000..5c8b23d
--- /dev/null
+++ b/src/dashboard/frontend/src/styles.css
@@ -0,0 +1,128 @@
+* { box-sizing: border-box; margin: 0; padding: 0; }
+
+body {
+  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
+  background: #f5f5f5;
+  color: #333;
+}
+
+.app { max-width: 1200px; margin: 0 auto; padding: 20px; }
+
+header {
+  display: flex;
+  align-items: center;
+  justify-content: space-between;
+  margin-bottom: 24px;
+  padding-bottom: 16px;
+  border-bottom: 1px solid #ddd;
+}
+
+header h1 { font-size: 1.4rem; }
+
+nav { display: flex; gap: 8px; }
+
+nav button {
+  padding: 8px 16px;
+  border: 1px solid #ccc;
+  border-radius: 4px;
+  background: white;
+  cursor: pointer;
+  font-size: 0.9rem;
+}
+
+nav button.active {
+  background: #4a90d9;
+  color: white;
+  border-color: #4a90d9;
+}
+
+.error {
+  background: #fee;
+  border: 1px solid #fcc;
+  color: #c00;
+  padding: 12px;
+  border-radius: 4px;
+  margin-bottom: 16px;
+}
+
+.loading { padding: 40px; text-align: center; color: #666; }
+
+.stats-grid {
+  display: grid;
+  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
+  gap: 16px;
+  margin-bottom: 24px;
+}
+
+.stat-card {
+  background: white;
+  border-radius: 8px;
+  padding: 20px;
+  box-shadow: 0 1px 3px rgba(0,0,0,0.1);
+}
+
+.stat-card h3 { font-size: 0.85rem; color: #666; margin-bottom: 8px; }
+.stat-value { font-size: 1.8rem; font-weight: 600; }
+
+.charts-row {
+  display: grid;
+  grid-template-columns: 1fr 1fr;
+  gap: 16px;
+}
+
+.chart-container {
+  background: white;
+  border-radius: 8px;
+  padding: 20px;
+  box-shadow: 0 1px 3px rgba(0,0,0,0.1);
+}
+
+.chart-container h3 { margin-bottom: 16px; font-size: 1rem; }
+
+.decisions-table {
+  background: white;
+  border-radius: 8px;
+  padding: 20px;
+  box-shadow: 0 1px 3px rgba(0,0,0,0.1);
+}
+
+table { width: 100%; border-collapse: collapse; }
+th, td { padding: 10px 12px; text-align: left; border-bottom: 1px solid #eee; }
+th { font-size: 0.85rem; color: #666; font-weight: 600; }
+td { font-size: 0.9rem; }
+
+.pagination {
+  display: flex;
+  align-items: center;
+  justify-content: space-between;
+  margin-top: 16px;
+  padding-top: 16px;
+  border-top: 1px solid #eee;
+}
+
+.pagination button {
+  padding: 6px 12px;
+  border: 1px solid #ccc;
+  border-radius: 4px;
+  background: white;
+  cursor: pointer;
+}
+
+.pagination button:disabled { opacity: 0.5; cursor: default; }
+
+.cost-chart {
+  background: white;
+  border-radius: 8px;
+  padding: 20px;
+  box-shadow: 0 1px 3px rgba(0,0,0,0.1);
+}
+
+.controls { margin-bottom: 16px; }
+
+.controls label {
+  font-size: 0.9rem;
+  cursor: pointer;
+  display: flex;
+  align-items: center;
+  gap: 8px;
+}
diff --git a/src/dashboard/frontend/tsconfig.json b/src/dashboard/frontend/tsconfig.json
new file mode 100644
index 0000000..9055208
--- /dev/null
+++ b/src/dashboard/frontend/tsconfig.json
@@ -0,0 +1,18 @@
+{
+  "compilerOptions": {
+    "target": "ES2022",
+    "module": "ESNext",
+    "moduleResolution": "bundler",
+    "lib": ["ES2022", "DOM", "DOM.Iterable"],
+    "jsx": "react-jsx",
+    "strict": true,
+    "noImplicitAny": true,
+    "esModuleInterop": true,
+    "forceConsistentCasingInFileNames": true,
+    "skipLibCheck": true,
+    "outDir": "dist",
+    "declaration": false,
+    "sourceMap": false
+  },
+  "include": ["src"]
+}
diff --git a/src/dashboard/frontend/vite.config.ts b/src/dashboard/frontend/vite.config.ts
new file mode 100644
index 0000000..d8cbf03
--- /dev/null
+++ b/src/dashboard/frontend/vite.config.ts
@@ -0,0 +1,18 @@
+import { defineConfig } from 'vite';
+import react from '@vitejs/plugin-react';
+
+export default defineConfig({
+  plugins: [react()],
+  base: './',
+  build: {
+    sourcemap: false,
+    outDir: 'dist',
+    assetsInlineLimit: 8192,
+  },
+  server: {
+    proxy: {
+      '/api': 'http://127.0.0.1:8788',
+      '/metrics': 'http://127.0.0.1:8788',
+    },
+  },
+});
diff --git a/tests/dashboard/spa/api-client-relative-urls.test.ts b/tests/dashboard/spa/api-client-relative-urls.test.ts
new file mode 100644
index 0000000..dd8ac52
--- /dev/null
+++ b/tests/dashboard/spa/api-client-relative-urls.test.ts
@@ -0,0 +1,45 @@
+import { describe, it, expect, beforeEach, vi } from 'vitest';
+
+describe('api client: relative URLs only', () => {
+  let capturedUrls: string[];
+
+  beforeEach(() => {
+    capturedUrls = [];
+    vi.stubGlobal('fetch', async (input: string | URL | Request) => {
+      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
+      capturedUrls.push(url);
+      return new Response(JSON.stringify({}), { status: 200 });
+    });
+  });
+
+  it('getSummary uses relative /api/summary path', async () => {
+    const { getSummary } = await import('../../../src/dashboard/frontend/src/api/client.js');
+    await getSummary();
+    expect(capturedUrls).toHaveLength(1);
+    expect(capturedUrls[0]).toBe('/api/summary');
+    expect(capturedUrls[0]).not.toMatch(/^https?:\/\//);
+  });
+
+  it('getDecisions uses relative /api/decisions path', async () => {
+    const { getDecisions } = await import('../../../src/dashboard/frontend/src/api/client.js');
+    await getDecisions({ limit: 50 });
+    expect(capturedUrls).toHaveLength(1);
+    expect(capturedUrls[0]).toBe('/api/decisions?limit=50');
+    expect(capturedUrls[0]).not.toMatch(/^https?:\/\//);
+  });
+
+  it('getCosts uses relative /api/costs path', async () => {
+    const { getCosts } = await import('../../../src/dashboard/frontend/src/api/client.js');
+    await getCosts({ bucket: 'day' });
+    expect(capturedUrls).toHaveLength(1);
+    expect(capturedUrls[0]).toBe('/api/costs?bucket=day');
+    expect(capturedUrls[0]).not.toMatch(/^https?:\/\//);
+  });
+
+  it('getDecisions with no params uses bare /api/decisions', async () => {
+    const { getDecisions } = await import('../../../src/dashboard/frontend/src/api/client.js');
+    await getDecisions();
+    expect(capturedUrls).toHaveLength(1);
+    expect(capturedUrls[0]).toBe('/api/decisions');
+  });
+});
diff --git a/tests/dashboard/spa/app-renders.test.tsx b/tests/dashboard/spa/app-renders.test.tsx
new file mode 100644
index 0000000..fd58091
--- /dev/null
+++ b/tests/dashboard/spa/app-renders.test.tsx
@@ -0,0 +1,70 @@
+// @vitest-environment jsdom
+import { describe, it, expect, beforeEach, vi } from 'vitest';
+import React from 'react';
+import { createRoot } from 'react-dom/client';
+import { act } from 'react-dom/test-utils';
+
+vi.mock('recharts', () => {
+  const Stub = (props: { children?: React.ReactNode }) =>
+    React.createElement('div', { 'data-testid': 'recharts-stub' }, props.children);
+  return {
+    PieChart: Stub,
+    Pie: Stub,
+    Cell: Stub,
+    BarChart: Stub,
+    Bar: Stub,
+    XAxis: Stub,
+    YAxis: Stub,
+    Tooltip: Stub,
+    Legend: Stub,
+    ResponsiveContainer: Stub,
+  };
+});
+
+const SUMMARY_FIXTURE = {
+  routingDistribution: { 'claude-opus-4': 10, 'claude-sonnet-4': 15 },
+  cacheHitRate: 0.45,
+  latency: { p50: 120, p95: 450, p99: 900 },
+  totalCost: 1.234,
+  classifierCost: 0.056,
+};
+
+const DECISIONS_FIXTURE = {
+  items: [],
+  limit: 100,
+  offset: 0,
+  total_scanned: 0,
+};
+
+const COSTS_FIXTURE = {
+  buckets: [],
+};
+
+describe('App smoke render', () => {
+  beforeEach(() => {
+    vi.stubGlobal('fetch', async (url: string) => {
+      let body = {};
+      if (url.includes('/api/summary')) body = SUMMARY_FIXTURE;
+      else if (url.includes('/api/decisions')) body = DECISIONS_FIXTURE;
+      else if (url.includes('/api/costs')) body = COSTS_FIXTURE;
+      return new Response(JSON.stringify(body), { status: 200 });
+    });
+  });
+
+  it('mounts <App /> without throwing', async () => {
+    const { default: App } = await import(
+      '../../../src/dashboard/frontend/src/App.js'
+    );
+    const container = document.createElement('div');
+    document.body.appendChild(container);
+
+    await act(async () => {
+      createRoot(container).render(React.createElement(App));
+    });
+
+    expect(container.querySelector('header')).not.toBeNull();
+    expect(container.textContent).toContain('ccmux Dashboard');
+
+    document.body.removeChild(container);
+  });
+});
diff --git a/tests/dashboard/spa/decisions-pagination.test.tsx b/tests/dashboard/spa/decisions-pagination.test.tsx
new file mode 100644
index 0000000..5cc1329
--- /dev/null
+++ b/tests/dashboard/spa/decisions-pagination.test.tsx
@@ -0,0 +1,64 @@
+// @vitest-environment jsdom
+import { describe, it, expect, beforeEach, vi } from 'vitest';
+import React from 'react';
+import { createRoot } from 'react-dom/client';
+import { act } from 'react-dom/test-utils';
+
+function makeRows(n: number) {
+  return Array.from({ length: n }, (_, i) => ({
+    decision_id: `d-${i}`,
+    timestamp: new Date().toISOString(),
+    session_id: 'sess-1',
+    request_hash: `hash-${i}`,
+    requested_model: 'claude-sonnet-4',
+    forwarded_model: 'claude-sonnet-4',
+    chosen_by: 'passthrough',
+    upstream_latency_ms: 100 + i,
+    cost_estimate_usd: 0.001,
+    classifier_cost_usd: null,
+    policy_result: { rule_id: null, action: 'forward', target_model: 'claude-sonnet-4' },
+    classifier_result: null,
+    usage: null,
+  }));
+}
+
+describe('decisions pagination', () => {
+  beforeEach(() => {
+    vi.stubGlobal('fetch', async (url: string) => {
+      if (url.includes('/api/decisions')) {
+        return new Response(
+          JSON.stringify({
+            items: makeRows(100),
+            limit: 100,
+            offset: 0,
+            total_scanned: 100,
+          }),
+          { status: 200 },
+        );
+      }
+      return new Response(JSON.stringify({}), { status: 200 });
+    });
+  });
+
+  it('renders decision rows from server response', async () => {
+    const { default: DecisionsTable } = await import(
+      '../../../src/dashboard/frontend/src/components/DecisionsTable.js'
+    );
+    const container = document.createElement('div');
+    document.body.appendChild(container);
+
+    await act(async () => {
+      createRoot(container).render(React.createElement(DecisionsTable));
+    });
+
+    await act(async () => {
+      await new Promise((r) => setTimeout(r, 50));
+    });
+
+    const rows = container.querySelectorAll('tbody tr');
+    expect(rows.length).toBe(100);
+    expect(rows.length).toBeLessThanOrEqual(1000);
+
+    document.body.removeChild(container);
+  });
+});
diff --git a/tests/dashboard/spa/no-cdn-in-html.test.ts b/tests/dashboard/spa/no-cdn-in-html.test.ts
new file mode 100644
index 0000000..75c25a0
--- /dev/null
+++ b/tests/dashboard/spa/no-cdn-in-html.test.ts
@@ -0,0 +1,35 @@
+import { describe, it, expect } from 'vitest';
+import { readFileSync, existsSync } from 'node:fs';
+import { join } from 'node:path';
+
+const INDEX_HTML = join(__dirname, '../../../src/dashboard/frontend/dist/index.html');
+
+describe('self-containment: no CDN in HTML', () => {
+  it('dist/index.html exists', () => {
+    expect(existsSync(INDEX_HTML)).toBe(true);
+  });
+
+  it('no external link/script/img references', () => {
+    const html = readFileSync(INDEX_HTML, 'utf8');
+
+    const srcPattern = /(?:src|href)\s*=\s*["']?(https?:\/\/[^"'\s>]+)/gi;
+    const violations: string[] = [];
+    let match;
+    while ((match = srcPattern.exec(html)) !== null) {
+      const url = match[1]!;
+      if (!/^https?:\/\/(127\.0\.0\.1|localhost)/.test(url)) {
+        violations.push(url);
+      }
+    }
+
+    expect(violations).toEqual([]);
+  });
+
+  it('no Google Fonts or CDN references', () => {
+    const html = readFileSync(INDEX_HTML, 'utf8');
+    expect(html).not.toContain('fonts.googleapis.com');
+    expect(html).not.toContain('cdn.');
+    expect(html).not.toContain('unpkg.com');
+    expect(html).not.toContain('jsdelivr');
+  });
+});
diff --git a/tests/dashboard/spa/no-outbound-urls.test.ts b/tests/dashboard/spa/no-outbound-urls.test.ts
new file mode 100644
index 0000000..ef54175
--- /dev/null
+++ b/tests/dashboard/spa/no-outbound-urls.test.ts
@@ -0,0 +1,49 @@
+import { describe, it, expect, beforeAll } from 'vitest';
+import { readdirSync, readFileSync, existsSync } from 'node:fs';
+import { join } from 'node:path';
+
+const DIST_DIR = join(__dirname, '../../../src/dashboard/frontend/dist');
+const ALLOWED_PATTERN = /https?:\/\/(127\.0\.0\.1|localhost|0\.0\.0\.0|www\.w3\.org|fb\.me|reactjs\.org)/;
+const URL_PATTERN = /https?:\/\/[^\s"'`,)\]}>]*/g;
+
+function walkDir(dir: string): string[] {
+  const results: string[] = [];
+  if (!existsSync(dir)) return results;
+  for (const entry of readdirSync(dir, { withFileTypes: true })) {
+    const full = join(dir, entry.name);
+    if (entry.isDirectory()) {
+      results.push(...walkDir(full));
+    } else {
+      results.push(full);
+    }
+  }
+  return results;
+}
+
+describe('self-containment: no outbound URLs', () => {
+  let violations: { file: string; url: string }[];
+
+  beforeAll(() => {
+    violations = [];
+    const files = walkDir(DIST_DIR);
+    for (const file of files) {
+      if (/\.(html|js|css|map|json)$/.test(file)) {
+        const content = readFileSync(file, 'utf8');
+        const matches = content.match(URL_PATTERN) ?? [];
+        for (const url of matches) {
+          if (!ALLOWED_PATTERN.test(url)) {
+            violations.push({ file: file.replace(DIST_DIR, ''), url });
+          }
+        }
+      }
+    }
+  });
+
+  it('dist/ exists after build', () => {
+    expect(existsSync(DIST_DIR)).toBe(true);
+  });
+
+  it('contains zero outbound URLs (only 127.0.0.1/localhost allowed)', () => {
+    expect(violations).toEqual([]);
+  });
+});
diff --git a/tests/dashboard/spa/no-remote-fonts.test.ts b/tests/dashboard/spa/no-remote-fonts.test.ts
new file mode 100644
index 0000000..0d60241
--- /dev/null
+++ b/tests/dashboard/spa/no-remote-fonts.test.ts
@@ -0,0 +1,37 @@
+import { describe, it, expect, beforeAll } from 'vitest';
+import { readdirSync, readFileSync, existsSync } from 'node:fs';
+import { join } from 'node:path';
+
+const DIST_DIR = join(__dirname, '../../../src/dashboard/frontend/dist');
+const FONT_URL_PATTERN = /url\s*\(\s*['"]?(https?:\/\/[^'")\s]+)/gi;
+
+function walkDir(dir: string): string[] {
+  const results: string[] = [];
+  if (!existsSync(dir)) return results;
+  for (const entry of readdirSync(dir, { withFileTypes: true })) {
+    const full = join(dir, entry.name);
+    if (entry.isDirectory()) results.push(...walkDir(full));
+    else results.push(full);
+  }
+  return results;
+}
+
+describe('self-containment: no remote fonts', () => {
+  let remoteFonts: { file: string; url: string }[];
+
+  beforeAll(() => {
+    remoteFonts = [];
+    const cssFiles = walkDir(DIST_DIR).filter(f => f.endsWith('.css'));
+    for (const file of cssFiles) {
+      const content = readFileSync(file, 'utf8');
+      let match;
+      while ((match = FONT_URL_PATTERN.exec(content)) !== null) {
+        remoteFonts.push({ file: file.replace(DIST_DIR, ''), url: match[1]! });
+      }
+    }
+  });
+
+  it('all @font-face url() values are relative or data: URIs', () => {
+    expect(remoteFonts).toEqual([]);
+  });
+});
diff --git a/tests/dashboard/spa/no-remote-sourcemaps.test.ts b/tests/dashboard/spa/no-remote-sourcemaps.test.ts
new file mode 100644
index 0000000..833dea6
--- /dev/null
+++ b/tests/dashboard/spa/no-remote-sourcemaps.test.ts
@@ -0,0 +1,40 @@
+import { describe, it, expect, beforeAll } from 'vitest';
+import { readdirSync, readFileSync, existsSync } from 'node:fs';
+import { join } from 'node:path';
+
+const DIST_DIR = join(__dirname, '../../../src/dashboard/frontend/dist');
+const SOURCEMAP_PATTERN = /\/\/[#@]\s*sourceMappingURL\s*=\s*(\S+)/g;
+
+function walkDir(dir: string): string[] {
+  const results: string[] = [];
+  if (!existsSync(dir)) return results;
+  for (const entry of readdirSync(dir, { withFileTypes: true })) {
+    const full = join(dir, entry.name);
+    if (entry.isDirectory()) results.push(...walkDir(full));
+    else results.push(full);
+  }
+  return results;
+}
+
+describe('self-containment: no remote source maps', () => {
+  let remoteSourcemaps: { file: string; url: string }[];
+
+  beforeAll(() => {
+    remoteSourcemaps = [];
+    const files = walkDir(DIST_DIR).filter(f => /\.(js|css)$/.test(f));
+    for (const file of files) {
+      const content = readFileSync(file, 'utf8');
+      let match;
+      while ((match = SOURCEMAP_PATTERN.exec(content)) !== null) {
+        const url = match[1]!;
+        if (url.startsWith('http://') || url.startsWith('https://')) {
+          remoteSourcemaps.push({ file: file.replace(DIST_DIR, ''), url });
+        }
+      }
+    }
+  });
+
+  it('all sourceMappingURL values are relative, data: URIs, or absent', () => {
+    expect(remoteSourcemaps).toEqual([]);
+  });
+});
diff --git a/tests/dashboard/spa/recharts-offline.test.tsx b/tests/dashboard/spa/recharts-offline.test.tsx
new file mode 100644
index 0000000..f9539d6
--- /dev/null
+++ b/tests/dashboard/spa/recharts-offline.test.tsx
@@ -0,0 +1,79 @@
+// @vitest-environment jsdom
+import { describe, it, expect, beforeEach, vi } from 'vitest';
+import React from 'react';
+import { createRoot } from 'react-dom/client';
+import { act } from 'react-dom/test-utils';
+import type { SummaryResponse } from '../../../src/dashboard/frontend/src/api/types.js';
+
+vi.mock('recharts', () => {
+  const Stub = (props: { children?: React.ReactNode }) =>
+    React.createElement('div', { 'data-testid': 'recharts-stub' }, props.children);
+  return {
+    PieChart: Stub,
+    Pie: Stub,
+    Cell: Stub,
+    BarChart: Stub,
+    Bar: Stub,
+    XAxis: Stub,
+    YAxis: Stub,
+    Tooltip: Stub,
+    Legend: Stub,
+    ResponsiveContainer: Stub,
+  };
+});
+
+const SUMMARY_DATA: SummaryResponse = {
+  routingDistribution: { 'claude-opus-4': 10, 'claude-sonnet-4': 12, 'claude-haiku-4': 8 },
+  cacheHitRate: 0.35,
+  latency: { p50: 100, p95: 400, p99: 800 },
+  totalCost: 2.5,
+  classifierCost: 0.1,
+};
+
+describe('Recharts offline rendering', () => {
+  beforeEach(() => {
+    vi.stubGlobal('fetch', async () => {
+      return new Response(JSON.stringify({ buckets: [] }), { status: 200 });
+    });
+  });
+
+  it('SummaryPanel renders stat cards without network', async () => {
+    const { default: SummaryPanel } = await import(
+      '../../../src/dashboard/frontend/src/components/SummaryPanel.js'
+    );
+    const container = document.createElement('div');
+    document.body.appendChild(container);
+
+    await act(async () => {
+      createRoot(container).render(
+        React.createElement(SummaryPanel, { data: SUMMARY_DATA }),
+      );
+    });
+
+    expect(container.querySelector('.summary-panel')).not.toBeNull();
+    expect(container.querySelector('.stat-value')).not.toBeNull();
+    expect(container.textContent).toContain('35.0%');
+
+    document.body.removeChild(container);
+  });
+
+  it('CostChart renders without network', async () => {
+    const { default: CostChart } = await import(
+      '../../../src/dashboard/frontend/src/components/CostChart.js'
+    );
+    const container = document.createElement('div');
+    document.body.appendChild(container);
+
+    await act(async () => {
+      createRoot(container).render(React.createElement(CostChart));
+    });
+
+    await act(async () => {
+      await new Promise((r) => setTimeout(r, 50));
+    });
+
+    expect(container.querySelector('.cost-chart')).not.toBeNull();
+
+    document.body.removeChild(container);
+  });
+});
diff --git a/vitest.config.ts b/vitest.config.ts
index f104c4c..8c66908 100644
--- a/vitest.config.ts
+++ b/vitest.config.ts
@@ -1,10 +1,22 @@
 import { defineConfig } from 'vitest/config';
+import path from 'node:path';
+import { fileURLToPath } from 'node:url';
+
+const __dirname = path.dirname(fileURLToPath(import.meta.url));
 
 export default defineConfig({
+  resolve: {
+    alias: {
+      react: path.resolve(__dirname, 'node_modules/react'),
+      'react-dom': path.resolve(__dirname, 'node_modules/react-dom'),
+      recharts: path.resolve(__dirname, 'node_modules/recharts'),
+    },
+    dedupe: ['react', 'react-dom'],
+  },
   test: {
     environment: 'node',
     globals: true,
-    include: ['tests/**/*.test.ts'],
+    include: ['tests/**/*.test.{ts,tsx}'],
     exclude: ['node_modules', 'dist', 'coverage', 'src/dashboard/frontend/**'],
     coverage: {
       provider: 'v8',
