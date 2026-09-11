# Tracker Magnet Auto-Copy

Userscript Tampermonkey/Violentmonkey pour **C411**, **Tr4ker** et **V3X** : un clic
sur "Télécharger" récupère le vrai `.torrent` en arrière-plan, en extrait le magnet
complet (avec l'URL de tracker) et le copie automatiquement dans le presse-papiers —
sans télécharger le fichier `.torrent` lui-même.

## Pourquoi

Un magnet "brut" (juste l'infohash, sans URL de tracker) ne trouve jamais de pairs
sur un debrideur (AllDebrid, etc.) pour un tracker privé, puisque DHT/PEX y sont
désactivés. Il faut le vrai fichier `.torrent`, qui contient l'annonce du tracker
(+ passkey), pour que ça fonctionne. Ce script fait cette extraction pour toi,
côté navigateur, sans dépendance externe (parsing bencode + SHA-1 natif).

## Ce qu'il fait

- Tu cliques sur "Télécharger" comme d'habitude sur C411, Tr4ker ou V3X
- Le script récupère le vrai `.torrent`, en extrait le magnet complet et le copie
  automatiquement dans le presse-papiers
- Plus besoin du fichier `.torrent` lui-même → plus de boîte de dialogue
  "Enregistrer sous" à chaque clic
- Un panneau flottant garde l'historique si tu enchaînes plusieurs téléchargements
  (season packs) : bouton "Copier tout" pour tout récupérer d'un coup
- Bouton optionnel pour envoyer directement le magnet à AllDebrid (jamais
  automatique, un clic à chaque fois — la clé API reste stockée en local dans
  Tampermonkey, jamais dans le script)
- Bouton optionnel pour télécharger quand même le `.torrent` réel si besoin, pour
  du seed ou les fichiers de plus de 100 Go (limite AllDebrid)

> ⚠️ Le magnet est traité par ton debrideur (AllDebrid...), pas par ton propre
> client torrent — ça ne seed pas pour toi vers le tracker. Si ton tracker impose
> un ratio/H&R, utilise le bouton `.torrent` + un vrai client pour seed
> manuellement.

## Installation

1. Installe l'extension [Tampermonkey](https://www.tampermonkey.net/) ou
   [Violentmonkey](https://violentmonkey.github.io/)
2. Télécharge [`unit3d-magnet-copy.user.js`](unit3d-magnet-copy.user.js)
3. Ouvre le fichier téléchargé (ou importe-le depuis le tableau de bord de
   l'extension) — l'installation est proposée automatiquement

## Sites supportés

- C411 (`c411.org`)
- Tr4ker (`tr4ker.net`)
- V3X (`v3x.club`)

## Licence

MIT — voir [LICENSE](LICENSE).
