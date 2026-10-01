# Rapport DocLayNet — 1 octobre 2026

## Objectif

Comparer deux LLM locaux utilisés comme classifieurs de layout sur un échantillon identique du split `test` de DocLayNet, avec un protocole reproductible et tolérant aux démarrages lents de `llama.cpp`.

Cette campagne évalue l’adaptateur du Harness. Elle n’évalue pas le service Mass Classification, dont les classes métier, les règles et le TNN ont un autre contrat.

## Protocole

| Paramètre | Valeur |
| --- | --- |
| Dataset | DocLayNet, split `test` |
| Pages | 20 premières pages (`start=0`, `limit=20`) |
| Objets | 203 annotations COCO |
| Objets maximum par page | 12 |
| Taille des lots | 4 objets par requête |
| Maximum de sortie | 1 400 tokens |
| Tentatives | 4 |
| Timeout d’une requête | 180 000 ms |
| Endpoint | OpenAI-compatible `llama.cpp` |
| Entrée envoyée | texte extrait, bbox normalisée, dimensions et contexte spatial |
| Pixels envoyés | non |

Les GGUF utilisés sont des modèles texte. Le benchmark est donc un protocole **layout-à-partir-du-texte-et-de-la-géométrie**, et non une évaluation vision multimodale.

## Matériel et modèles

| Élément | Valeur |
| --- | --- |
| Système | Windows 11 Famille 64 bits |
| CPU visible | AMD EPYC 9354, 4 cœurs / 8 threads, 3,25 GHz max |
| GPU visible | NVIDIA RTX 2000 Ada Generation, environ 4 Go dédiés exposés |
| RAM visible | 16 Go |
| Runtime | Node.js 24.19.0, `llama-server.exe` |
| GPT-OSS | `gpt-oss-20b-MXFP4.gguf`, modèle 20B |
| Qwen | `qwen3.6-27b-instruct-Q4_K_M.gguf`, modèle 27B Instruct |

Chemins locaux utilisés :

```text
C:\Users\Shadow\Models\gguf\gpt-oss-20b-mxfp4\gpt-oss-20b-MXFP4.gguf
C:\Users\Shadow\Models\gguf\qwen3.6-27b-instruct-q4_k_m\qwen3.6-27b-instruct-Q4_K_M.gguf
```

## Résultats

| Modèle | Endpoint | Pages | Objets | Valides | Accuracy tous objets | Accuracy valides | Macro-F1 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| GPT-OSS 20B MXFP4 | `:8082` | 20 | 203 | 203 | 82,76 % | 82,76 % | 66,85 % |
| Qwen 3.6 27B Q4_K_M | `:8080` | 20 | 203 | 202 | 78,82 % | 79,21 % | 56,48 % |

### F1 par classe

| Classe | Support | GPT-OSS | Qwen |
| --- | ---: | ---: | ---: |
| Caption | 2 | 66,7 % | 0,0 % |
| Footnote | 1 | 100,0 % | 100,0 % |
| List-item | 6 | 60,0 % | 44,4 % |
| Page-footer | 18 | 81,8 % | 75,0 % |
| Page-header | 14 | 21,1 % | 22,2 % |
| Picture | 19 | 80,0 % | 75,7 % |
| Section-header | 28 | 76,7 % | 77,2 % |
| Table | 24 | 89,4 % | 81,0 % |
| Text | 90 | 92,9 % | 89,4 % |
| Title | 1 | 0,0 % | 0,0 % |

`Formula` n’apparaît pas dans cet échantillon. Les classes avec un support inférieur à cinq objets ne doivent pas être interprétées seules.

## Analyse des erreurs

Les confusions Qwen les plus fréquentes sont :

| Vérité terrain → prédiction | Occurrences |
| --- | ---: |
| Page-header → Page-footer | 6 |
| Page-header → Section-header | 5 |
| Table → Text | 4 |
| Section-header → Text | 4 |
| Text → Picture | 3 |
| Picture → Page-footer | 3 |

Le point faible commun est la séparation entre les éléments de structure de page : `Page-header`, `Section-header` et `Page-footer`. La baisse Qwen est particulièrement visible sur `Table`, `List-item` et `Caption`. GPT-OSS obtient ici le meilleur compromis global, tandis que Qwen reste légèrement supérieur sur `Page-header` et `Section-header` dans cet échantillon.

Le run Qwen contient un timeout final sur l’objet `113`, attendu `Table`, page 23 du document source. La page est marquée `partial`, le rapport est marqué `completed` parce que la campagne elle-même a atteint sa fin et le checkpoint a été conservé. Cette distinction est importante lors de l’analyse automatisée.

## Reproduction

Depuis la racine du dépôt Harness :

```powershell
npm.cmd run local:llm:gpt-oss
```

Puis, dans un autre terminal :

```powershell
npm.cmd run doclaynet:eval -- `
  --split test --start 0 --limit 20 --max-objects 12 `
  --objects-per-request 4 --max-tokens 1400 --attempts 4 `
  --request-timeout-ms 180000 --health-wait-ms 30000 `
  --retry-delay-ms 2000 --endpoint http://127.0.0.1:8082/v1 `
  --model harness-local --output .harness/doclaynet/gpt-oss-stable-test.json
```

Pour Qwen, remplacer le serveur par `npm.cmd run local:llm:qwen`, attendre un retour HTTP 200 sur `http://127.0.0.1:8080/health`, puis utiliser `--endpoint http://127.0.0.1:8080/v1` et un nom de sortie Qwen.

Après une interruption ou un timeout :

```powershell
npm.cmd run doclaynet:eval -- `
  --split test --start 0 --limit 20 --max-objects 12 `
  --objects-per-request 2 --max-tokens 1400 --attempts 6 `
  --request-timeout-ms 300000 --health-wait-ms 30000 `
  --retry-delay-ms 3000 --resume `
  --endpoint http://127.0.0.1:8080/v1 --model harness-local `
  --output .harness/doclaynet/qwen-stable-test.json
```

## Conclusion

Sur cette campagne courte et textuelle, GPT-OSS 20B est le meilleur candidat pour poursuivre les essais de classification DocLayNet. Qwen 3.6 27B reste exploitable et le pipeline est stable, mais nécessite une évaluation plus large et probablement un réglage spécifique des consignes pour les en-têtes, les tableaux et les légendes.

La prochaine étape recommandée est d’évaluer au moins plusieurs centaines de pages, de conserver une partition de validation séparée et d’ajouter un test vision si l’objectif final est de classer les pixels et non seulement les sorties textuelles et géométriques.
