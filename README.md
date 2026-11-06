# Quedem

Web en català per trobar una data en grup: accés amb enllaç, disponibilitat manual
per a Apple/iCloud i connexions OAuth amb Google Calendar i Outlook. Projecte
independent de `portfoli`, sense cap dependència ni modificació d'aquell repositori.

## Desplegament actual

https://quedem-one.vercel.app

Vercel amb Neon en pla gratuït. La participació manual és operativa. Les
credencials de Google estan configurades a Production i desplegades. Outlook
encara no està configurat i no es mostra com a disponible.

Google ja té el projecte `quedem-513823`, Calendar API, consentiment extern en
mode Testing i client web amb la redirecció configurats. S'han verificat amb un
compte real el consentiment, la llista de calendaris, la sincronització de dos
calendaris i l'exclusió dels intervals ocupats a les propostes de producció.
La trobada temporal i les dades de participació s'han eliminat després de la
prova. Actualment només el compte de l'administrador és usuari de prova: cal
afegir els correus Google dels amics a **Audience > Test users** abans que
puguin connectar els seus calendaris. La participació manual no té aquest límit.

Outlook queda ajornat expressament. No s'ha registrat cap aplicació al
directori d'Assembler: cal un directori propi o autoritzat abans de continuar.

### Imatge en compartir i icones

L'HTML inicial inclou Open Graph i Twitter Card amb una imatge PNG de
1200 × 630, apta per a previsualitzacions de WhatsApp sense executar JavaScript.
La composició és pròpia, amb paper crema, tinta verda, accent groc i una agenda.
És genèrica: no publica noms, dates ni disponibilitats dels participants.
No es fixa una URL canònica de portada a les metadades, per conservar l'enllaç
concret de cada pla. WhatsApp pot conservar en memòria cau les targetes dels
enllaços ja enviats; els missatges antics no s'actualitzen automàticament.

El favicon és un interrogant groc sobre verd, en SVG i ICO de 32/48 píxels;
també hi ha una icona PNG de 180 píxels per desar la web a la pantalla d'inici.
Els fitxers es serveixen tant a Vercel com al servidor local.
Per regenerar els PNG i l'ICO a Windows, sense dependències noves:
`powershell -ExecutionPolicy Bypass -File .\scripts\generate-brand-assets.ps1`.
L'SVG manté la mateixa geometria vectorial. `test/brand.test.js` comprova
les metadades inicials, les dimensions i els formats.

## Executar

Les dates visibles i els camps d'entrada fan servir `dd/mm/aaaa`,
independentment de l'idioma del navegador. Es conserva el selector natiu de
calendari; el servidor continua rebent dates ISO. Els noms es normalitzen
(Unicode, majúscules i espais) i l'alta es serialitza per pla en una transacció
per impedir duplicats, també amb inscripcions simultànies.

Node 22.x. `npm install`, copiar `.env.example` a `.env`, configurar-lo
i executar `node --env-file=.env server.js`. `npm test` i `npm run check` validen
el càlcul, els límits, els permisos i els adaptadors. Sense base de dades la
interfície mostra un avís i no simula esdeveniments desats.
La regressió persistent del grup s'executa amb `QUEDEM_INTEGRATION=1`
i `DATABASE_URL` configurada: `node --test test/group.integration.test.js`.
Crea plans temporals propis i els elimina; comprova dos navegadors, secrets
privats, edició pel nom, permisos d'organitzador, vinculació OAuth,
desconnexió de calendaris i retirada de dades.

### Validació de coincidències en grup

La prova d'OAuth amb una sola persona només certifica la connexió, no una
coincidència de grup. Les regressions inclouen tres calendaris independents,
alternatives completes i parcials, horaris diferents segons el dia i una cerca
de 60 dies sense truncament. A producció s'ha contrastat també un quart
participant de control amb conflictes propis.

Per a la prova guiada s'utilitza una trobada separada, amb tres participants
identificats explícitament com a simulats, sense autoritzacions OAuth fictícies
ni accés a calendaris reals d'altres persones. Els seus intervals són dades
de prova: abans d'afegir el calendari real, dilluns coincideixen de 17 a 18 h,
dimarts de 18 a 19 h i dimecres tenen diversos inicis entre les 17 i les 18 h.
Dijous no hi ha cap hora per als tres. Afegir una quarta persona pendent no
la considera lliure: després de connectar i consultar el seu calendari, cal
comprovar els recomptes sobre quatre i l'exclusió dels seus conflictes.
Les dades simulades també queden subjectes al límit de frescor de 24 hores.

## Vercel i base de dades

Desplegar el projecte com a **Other**, amb `public` com a directori de sortida,
sense ordre de build. Les funcions viuen a `api/index.js`. Connectar una base
Postgres Neon del Marketplace amb pla gratuït i `DATABASE_URL`. Les taules es
creen automàticament a la primera petició. Configurar `APP_URL` amb l'URL
canònica del desplegament (sense barra final) i `APP_SECRET` amb una clau
aleatòria d'almenys 32 caràcters. La clau no pot canviar sense invalidar les
autoritzacions xifrades existents; si es canvia, cal reconnectar els calendaris.
No desar secrets al repositori.

## Google Calendar

1. A [Google Cloud](https://console.cloud.google.com/), crear o seleccionar un
   projecte `Quedem`. A **APIs & Services > Library**, activar **Google Calendar
   API**. No cal crear una API key ni desplegar cap servidor a Google.
2. A **Google Auth Platform > Branding**, configurar el nom `Quedem`, el correu
   de suport i el correu de contacte. Acceptar personalment les condicions.
3. A **Audience**, triar **External**, mantenir **Testing** i afegir a **Test
   users** el teu correu Google i el de cadascun dels participants del grup.
4. A **Data Access**, afegir exactament:
   - `https://www.googleapis.com/auth/calendar.events.readonly`
   - `https://www.googleapis.com/auth/calendar.calendarlist.readonly`
5. A **Clients > Create client**, triar **Web application**, no Desktop, i
   configurar a **Authorized redirect URIs** aquesta adreça exacta, sense barra
   final:
   `https://quedem-one.vercel.app/api/oauth/google/callback`.
   Aquest flux és de servidor: no necessita **Authorized JavaScript origins**.
6. Copiar **Client ID** i **Client secret** directament a les variables Vercel
   indicades més avall. Google només mostra el secret en crear-lo: desar-lo
   de manera segura, mai al xat ni al codi.

La llista permet seleccionar diversos calendaris. Consultem instàncies dels
esdeveniments, incloent recurrències, hores i títols, sense descripcions ni
permisos d'escriptura. Els detalls es xifren i només es retornen al participant
propietari per revisar els conflictes. Les connexions antigues amb només
`calendar.events.freebusy` continuen calculant la disponibilitat, però cal
reconnectar per autoritzar la lectura dels títols. No s'amplien permisos
silenciosament en renovar un token. Fora dels usuaris de prova pot caldre verificació
de Google abans de fer l'app pública. Amb aquests permisos, les autoritzacions
en mode Testing caduquen al cap de 7 dies: cal reconnectar el calendari.

## Outlook personal i Microsoft 365

Cal accés a un directori de Microsoft Entra amb permís per registrar
aplicacions. Un compte personal Outlook, per si sol, no garanteix aquest accés.
La guia de Microsoft demana un compte Azure amb subscripció activa, un tenant i
com a mínim el rol **Application Developer**. Si no tens aquest entorn, cal
resoldre aquest requisit abans de continuar; no contractar serveis de pagament
només per seguir aquestes instruccions.

1. A [Microsoft Entra](https://entra.microsoft.com/), entrar a **Entra ID >
   App registrations > New registration**, nom `Quedem`.
2. A **Supported account types**, seleccionar **Any Entra ID Tenant + Personal
   Microsoft accounts** (comptes de qualsevol organització i comptes personals),
   no l'opció limitada a una única organització.
3. A **Authentication > Add a platform**, triar **Web**, no SPA, amb la redirecció:
   `https://quedem-one.vercel.app/api/oauth/microsoft/callback`.
4. A **API permissions > Add a permission > Microsoft Graph > Delegated
   permissions**, afegir **Calendars.ReadBasic** i **offline_access**.
   No triar **Application permissions** ni permisos d'escriptura.
5. A **Certificates & secrets > Client secrets > New client secret**, crear
   el secret, apuntar-ne la caducitat i copiar **Value**, no **Secret ID**.
   El valor només es mostra en crear-lo.
6. A **Overview**, copiar **Application (client) ID**, no Directory (tenant) ID
   ni Object ID. Desar l'ID i el valor del secret a Vercel.

Consultem `calendarView` per incloure recurrències i excepcions, paginem totes
les respostes i demanem només `id,subject,start,end,showAs,isCancelled,seriesMasterId`. `getSchedule`
no serveix per a comptes personals. Una organització pot exigir consentiment
de l'administrador. No es demanen permisos d'escriptura. Aquesta versió usa
secret de client; Microsoft recomana substituir els secrets per certificats o
credencials federades en producció. Aquest canvi d'autenticació no està
implementat en aquesta versió. Cal renovar el secret abans que caduqui.

## Desar les quatre claus i activar les connexions

A [Vercel > Quedem > Settings > Environment Variables](https://vercel.com/frolestis-projects/quedem/settings/environment-variables),
afegir les variables a l'entorn **Production**, sense cometes, espais ni salts
de línia sobrers. Marcar els secrets com a sensibles si l'opció està disponible.

| Variable | Valor que cal copiar |
| --- | --- |
| `GOOGLE_CLIENT_ID` | Client ID del client Web de Google |
| `GOOGLE_CLIENT_SECRET` | Client secret de Google |
| `MICROSOFT_CLIENT_ID` | Application (client) ID d'Entra |
| `MICROSOFT_CLIENT_SECRET` | Value del secret d'Entra, no Secret ID |

`DATABASE_URL`, `APP_SECRET` i `APP_URL` ja estan configurades al desplegament
actual: no cal modificar-les. Es pot activar un proveïdor sense l'altre.

Després de desar, anar a **Deployments > últim desplegament > Redeploy**. Desar
variables no modifica un desplegament que ja està executant-se.

Prova real: crear una trobada, entrar amb el nom, connectar Google o Outlook,
acceptar els permisos, seleccionar calendaris i prémer **Actualitzar
disponibilitat**. Comprovar que una cita ocupada dins de la franja no apareix
com a disponible. Repetir-ho amb un altre participant i amb cada tipus de compte
Microsoft que es vulgui admetre. Les proves simulades no certifiquen una
connexió real; tenir variables configurades tampoc garanteix que siguin vàlides.

Referències: [clients OAuth de Google](https://support.google.com/cloud/answer/15549257),
[consentiment Google](https://developers.google.com/workspace/guides/configure-oauth-consent),
[registre d'apps Entra](https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-register-app)
i [credencials Entra](https://learn.microsoft.com/en-us/entra/identity-platform/how-to-add-credentials).

## Direcció visual

Agenda de paper: fons cru `#f3f0e6`, tinta verda `#193b32`, accent groc
`#e4e88e`, titulars Georgia i controls amb tipografia de sistema. Formularis
oberts, separadors i resultats en forma de llista; sense gradients, ombres,
estrelles de marca, targetes arrodonides repetides ni xifres fictícies.
La proposta es resumeix a partir dels camps reals del formulari. Les opcions
són genèriques i no es canvien els esdeveniments que ja existeixen.

S'han aplicat els principis de
[la guia AskGlitch](https://www.askglitch.com/guides/how-to-make-ai-websites-not-look-ai),
no una còpia de cap web ni eines de tercers instal·lades. L'article de Medium
facilitat retornava HTTP 403 durant la consulta i no se'n pressuposa el contingut.

## Privadesa i comportament

- Sense registre a Quedem. Es comparteix l'enllaç del pla amb el menú natiu
  del dispositiu o copiant-lo. Si això falla, es mostra l'enllaç seleccionable.
  No hi ha camp ni codi visible per entrar: l'identificador intern de 14
  caràcters continua a l'URL per conservar els enllaços i les sessions existents.
  La marca és «quedem?», sense eslògan; els textos de pantalla són operatius.
  Les durades es mostren en hores. Canviar la primera data ajusta l'última si
  queda abans, i limita la cerca a 60 dies; si l'última data continua sent
  vàlida, es conserva.
- Cookies HttpOnly, SameSite=Lax, Secure en HTTPS, de 90 dies per esdeveniment:
  el navegador reconeix la participació. Les dades viuen a Neon Postgres i
  sobreviuen a recàrregues, tancaments del navegador i desplegaments.
  Incògnit no comparteix aquesta identitat i l'esborra en tancar-ne les finestres.
  No hi ha enllaços personals, ni per crear-los ni per recuperar-los:
  els endpoints anteriors retornen 404. Es conserven les sessions de navegador
  ja autoritzades, sense permetre que un enllaç antic n'autoritzi de noves.
  El nom no acredita identitat privada. «Qui ets?» permet seleccionar
  un participant i editar únicament dies i hores bloquejats, confiant en el grup.
  Qualsevol persona amb l'enllaç del pla pot modificar aquests bloquejos.
  Aquesta selecció es recorda en una taula separada i no concedeix accés a
  calendaris, títols, intervals, flexibilitat, sincronització, autoritzacions,
  retirada de participació ni permisos d'organitzador.
  El servidor rebutja aquestes operacions, no només les oculta a la interfície.
  «Connectar Google Calendar» continua visible després de seleccionar un nom.
  L'autorització de Google pot recuperar l'accés privat des d'un altre navegador:
  si ja hi havia Google vinculat, es verifica el mateix calendari principal
  del compte, no la coincidència d'un calendari compartit. Les participacions
  antigues sense identificador de compte es verifiquen amb l'autorització
  anterior; si ha caducat, cal reconnectar des del navegador original.
  Una participació manual pot vincular el compte que autoritza expressament.
  Només després de verificar Google s'emet una cookie privada de navegador,
  sense enllaços personals ni transferir permisos d'organitzador.
  Es conserven els bloquejos i, en recuperar Google, els calendaris i les
  preferències existents. L'estat OAuth continua vinculat al navegador iniciador
  i a la persona seleccionada. Outlook no disposa d'aquesta recuperació.
  Només es permet en plans amb disponibilitat nominal; els plans antics agregats
  conserven la seva privadesa. Els identificadors públics són opacs, no hashes
  de sessió. El selector sempre queda accessible, també amb una participació
  privada activa. «No hi soc: afegir-me» desfà una selecció i recupera el formulari;
  si el navegador ja té participació pròpia, permet tornar-hi sense perdre dades.
  Els noms repetits demanen seleccionar el participant o afegir un
  cognom diferent. L'organitzador conserva el control del pla només al
  navegador on el va crear.
- Només el mateix participant rep els noms dels seus calendaris i els títols
  dels seus compromisos. Els títols i les autoritzacions es guarden xifrats.
  Els plans nous (`namedAvailability: true`) mostren a tothom del pla, per horari,
  qui pot venir, qui no pot i qui està pendent, amb avís abans d'afegir-s'hi.
  No hi ha una opció individual per ocultar aquest estat. Les trobades antigues
  sense aquesta política mantenen únicament recomptes agregats; no se'n canvia
  la privadesa retroactivament. La prova guiada s'ha actualitzat expressament.
  Ni els títols ni els intervals originals del calendari es retornen al grup.
- Autoritzacions OAuth xifrades AES-256-GCM, estat d'un sol ús amb caducitat,
  PKCE, verificació del navegador i verificació d'Origin per a mutacions.
- Consulta pròpia en entrar al pla i botó d'actualització; no hi ha sincronització
  contínua en segon pla. Després de 24 hores sense consultar, aquella agenda no
  es compta com a lliure. Un error de consulta invalida l'última disponibilitat.
  Els calendaris es mostren en un desplegable natiu (`details`/`summary`),
  sense botó de mostrar/amagar, amb el recompte de calendaris seleccionats. En entrar,
  es mostren si encara no n'hi ha cap seleccionat; si ja hi ha selecció,
  es pleguen. L'estat triat es conserva durant els recàlculs i sincronitzacions
  de la pàgina, sense canviar la selecció ni els permisos.
  «Actualitzar calendari» queda fora del desplegable i continua accessible
  amb els calendaris plegats. Si falla la sincronització de Google, es mostra
  també «Reconnectar Google Calendar», sense haver de desconnectar abans.
  Google s'etiqueta «Connectar Google Calendar» i, un cop connectat,
  «Desconnectar Google Calendar»; Outlook segueix el mateix patró.
  Desconnectar demana confirmació, elimina credencials, compromisos, polítiques
  flexibles i autoritzacions pendents, però conserva els bloquejos manuals.
  La resta dels horaris passa a disponible. No es modifica el calendari del
  proveïdor ni es revoca el consentiment global del compte.
  No hi ha botó «Introduir manualment»: els bloquejos sempre són accessibles.
- En afegir-se manualment, tots els horaris són disponibles fins que es
  bloquegen dies o hores. No hi ha botó de confirmació de tots els dies lliures.
  Les participacions manuals antigues pendents també compten com a lliures,
  respectant bloquejos explícits; les seleccions parcials ja confirmades es
  conserven. Els calendaris pendents, fallits o caducats continuen pendents,
  mai es pressuposen lliures. El mateix editor permet, amb calendari o sense,
  bloquejar dies sencers o hores concretes. Passar d'un calendari a manual demana confirmació
  perquè elimina l'autorització i declara lliures els horaris no bloquejats.
  Es poden seleccionar diversos dies arrossegant amb ratolí o dit, sense
  cap botó per activar la selecció múltiple. Un tap/clic/teclat edita un dia.
  Després s'escull dia sencer
  o una franja comuna. Al mòbil es desplaça la pàgina fora dels botons de data.
  El diàleg aplica els bloquejos i recalcula el grup automàticament, sense
  «Desar preferències». L'acció de selecció múltiple és a la barra superior
  fixa de les dates i només apareix si hi ha dates seleccionades. Un error
  deixa el diàleg obert i no aplica visualment un canvi que no s'ha desat.
  Seleccionar calendaris també consulta i actualitza automàticament, amb
  restauració de la selecció si falla. S'admeten
  fins a 240 franges d'hores senceres, validades i fusionades al servidor.
  Qualsevol solapament bloqueja la proposta completa, encara que el compromís
  sigui flexible. Les persones pendents mai no es consideren disponibles.
- Les propostes comencen només a les hores en punt, respecten la durada, la franja i
  Europe/Madrid, incloent canvis d'horari d'estiu i sopars fins a mitjanit.
  Es retornen tots els horaris amb almenys una persona disponible, sense tall
  als primers dies ni a una sola hora per dia. La interfície els agrupa per dia,
  ordena els dies i les hores cronològicament dins de cada llista i mostra directament els horaris sense
  conflictes per a tothom. Els horaris parcials o amb participants pendents
  queden dins de «Mostrar altres horaris». Cada opció permet desplegar
  l'assistència individual. Amb una
  sola persona no es parla de coincidència de grup. Dates, franja i durada es
  mostren juntes a la capçalera del pla.
  Una única fletxa funcional permet amagar o tornar a mostrar tots els dies
  sense cap horari amb coincidència completa. Els dies amb algun horari per a
  tothom continuen visibles, incloent les seves alternatives parcials plegades.
  Es conserva l'ordre cronològic i el filtre durant els recàlculs de la pàgina;
  si no hi ha dies complets, es mostra com recuperar les alternatives amagades.
  A partir de 851 píxels d'amplada i 480 d'alçada, la columna de participació
  queda fixada a 16 píxels del marge superior mentre es recorren els resultats.
  Si no hi cap sencera, té desplaçament propi i tots els controls són accessibles.
  En pantalles petites o molt baixes es manté el desplaçament normal.
  Els plans nous tenen durades d'1, 2, 3 o 4 hores; els plans anteriors conserven
  la seva durada sense modificar-la retroactivament.
- Revisió privada de conflictes: marcar o desmarcar un compromís com a flexible
  es desa i recalcula els resultats automàticament, sense tornar a consultar el
  proveïdor ni haver de confirmar de nou. L'estat ocupat/flexible i
  els recomptes personals es mostren actualitzats. Només afecta aquest
  pla. Si un compromís ocupa només part d'una proposta, una pregunta privada
  demana explícitament si es pot assistir malgrat això. El sí declara flexible
  tot aquell compromís, no només una proposta, i ho adverteix abans de confirmar.
  El no manté el bloqueig i es recorda per no repetir la pregunta en cada visita.
  Sense resposta el solapament continua bloquejant; mai no es presumeix lliure.
  Un altre compromís solapat, un dia exclòs o una franja manual continuen bloquejant l'horari.
  Els identificadors depenen del calendari, de la instància i de les hores:
  si un compromís es mou o desapareix, es retira l'excepció en sincronitzar.
  Es validen contra la consulta actual i s'admeten fins a 100 excepcions.
  Les respostes negatives també es retiren si el compromís canvia o desapareix.
  Les recurrències s'identifiquen per `recurringEventId` de Google o
  `seriesMasterId` d'Outlook, mai pel títol. Es guarden identificadors de sèrie
  opacs i específics del proveïdor i calendari. La revisió privada agrupa les
  sessions; «Tota la sèrie és flexible» desa una regla flexible o bloquejant
  per a aquest pla, incloent instàncies que apareguin en consultes posteriors.
  Aquest control és fora del desplegable i sempre visible; només les sessions
  individuals queden plegades.
  Cada sessió pot tenir una excepció explícita que preval sobre la regla.
  Tornar a canviar tota la sèrie elimina les excepcions de les seves sessions.
  Els bloquejos manuals sempre prevalen i no es modifica el calendari original.
  S'admeten fins a 100 regles validades contra les sèries de la consulta actual.
  No es filtren identificadors ni polítiques de sèrie a les respostes del grup.
  No hi ha franja global d'avisos ni missatges de desament o actualització.
  Els errors es mostren al diàleg d'edició actiu o en un diàleg tancable.
  Els paràmetres OAuth `notice` es consumeixen i retiren de l'URL abans de
  carregar dades: reconnectar o recarregar no ressuscita un avís antic.
  La confirmació de connexió no mostra cap missatge; la selecció de calendaris
  ja indica el següent pas. La còpia de l'enllaç canvia temporalment el text
  del mateix botó, sense afegir una franja a la pàgina.
- Eliminar la participació o passar a manual elimina les credencials i els
  detalls privats desats;
  revocar també a Google/Microsoft si es vol retirar el consentiment al proveïdor.
- Retenció: els esdeveniments i dades associades s'eliminen en peticions al
  servei un cop han passat 7 dies de la data final de cerca. No és una tasca
  programada: si no hi ha peticions, les dades romanen fins a la pròxima neteja.
- Límits tècnics: 60 dies per cerca, 20 calendaris per connexió, 10 creacions/h,
  20 sincronitzacions/h per participant i 400 peticions/h per IP.
