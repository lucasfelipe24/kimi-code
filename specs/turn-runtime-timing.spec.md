# Feature: Tempo ativo de cada turn na TUI e Web

## Overview

Adicionar um cronômetro discreto às interfaces finais `apps/kimi-code` (TUI) e
`apps/kimi-web` para que o usuário veja há quanto tempo o turn principal está
executando e, ao final, quanto trabalho ativo ele consumiu. O cronômetro começa
somente em `turn.started`, atualiza em segundos inteiros, congela enquanto o
agente aguarda aprovação ou resposta humana e registra no transcript o desfecho
com a duração.

## Functional Requirements (EARS)

### FR-001: Início autoritativo do cronômetro

When a interface receber `turn.started` para o agente principal,
the system shall iniciar um novo cronômetro monotônico para aquele turn com
duração ativa igual a zero.

### FR-002: Exclusão da fila e pré-dispatch

While uma solicitação estiver apenas enviada, sendo despachada ou aguardando
na fila,
the system shall not acumular duração do turn antes de `turn.started`.

### FR-003: Atualização ao vivo

While o turn principal estiver ativo e não estiver aguardando interação humana,
the system shall atualizar o indicador visual em segundos inteiros, no mínimo
uma vez por segundo.

### FR-004: Pausa por aprovação

While houver uma aprovação humana pendente durante o turn principal,
the system shall congelar a duração ativa e indicar que está aguardando o
usuário.

### FR-005: Pausa por pergunta

While houver uma pergunta humana pendente durante o turn principal,
the system shall congelar a duração ativa e indicar que está aguardando o
usuário.

### FR-006: Interações sobrepostas

While uma ou mais aprovações/perguntas estiverem pendentes,
the system shall tratar os intervalos sobrepostos como uma única pausa e
somente retomar o cronômetro quando nenhuma espera humana permanecer.

### FR-007: Retomada

When a última interação humana pendente for resolvida, rejeitada, cancelada ou
dispensada e o turn ainda estiver ativo,
the system shall retomar a acumulação a partir da duração congelada.

### FR-008: Finalização e desfecho

When o sistema receber `turn.ended`,
the system shall congelar definitivamente a duração ativa e associar um dos
desfechos `completed`, `failed`, `blocked` ou `cancelled` ao turn.

### FR-009: Linha final no transcript

When um turn medido terminar,
the system shall registrar uma linha discreta no transcript equivalente a
"Completed in 12s", "Failed after 12s", "Blocked after 12s" ou
"Cancelled after 12s", usando a duração ativa e o idioma/convenções da
interface.

### FR-010: Turns sem início observado

When a interface observar um turn em andamento ou seu término sem ter observado
o respectivo `turn.started`,
the system shall manter o feedback de execução existente e não exibir uma
duração numérica potencialmente incorreta.

### FR-011: Isolamento entre turns

When um turn terminar e uma mensagem enfileirada iniciar outro turn,
the system shall finalizar o primeiro cronômetro antes de criar um cronômetro
independente para o novo `turn.started`.

### FR-012: Cobertura dos gatilhos de turn

When prompt, skill, plugin command, cron ou goal produzir um turn principal,
the system shall aplicar o mesmo comportamento de cronômetro sem depender da
origem do turn.

## Non-Functional Requirements

### Performance

- O relógio visual deve usar no máximo um tick por segundo por interface
  ativa; não deve reagir a cada delta de streaming.
- Timers e listeners devem ser limpos ao finalizar o turn, trocar/descartar
  sessão, desmontar componente ou encerrar a interface.

### Security & Privacy

- A feature não registra prompt, resposta, conteúdo de aprovação/pergunta ou
  qualquer dado sensível adicional. Apenas timestamps/duração, estado de pausa
  e desfecho são mantidos em memória.

### Compatibility & Accessibility

- Campos/tipos novos são opcionais para compatibilidade com fixtures e estados
  antigos.
- O estado de pausa e o desfecho não dependem apenas de cor — há texto
  explícito.
- Web usa tokens do design system e i18n en/zh.

### Precision

- Duração ativa = `max(0, endedAt - startedAt - uniãoDosIntervalosDePausa)`.
- Apresentação em segundos inteiros sem casas decimais.

## Acceptance Criteria

### AC-001: Turn normal ao vivo

Given uma solicitação foi enviada e ainda não recebeu `turn.started`,
When a interface está aguardando o início,
Then o feedback de execução existente permanece visível sem cronômetro
numérico.

Given o `turn.started` é recebido,
When passam 3,8 segundos sem espera humana,
Then o indicador mostra `3s` e continua atualizando uma vez por segundo.

### AC-002: Solicitação enfileirada

Given um turn está ativo e outra solicitação está na fila,
When a solicitação enfileirada aguarda 20 segundos,
Then esses 20 segundos não entram em sua duração.

Given o primeiro turn termina,
When a solicitação enfileirada recebe seu próprio `turn.started`,
Then seu cronômetro começa em `0s`.

### AC-003: Aprovação pausa o relógio

Given um turn acumulou 5 segundos ativos,
When uma aprovação é apresentada por 10 segundos,
Then o indicador permanece em `5s` e mostra que aguarda o usuário.

Given a aprovação é resolvida,
When o turn executa por mais 3 segundos,
Then a duração ativa final é `8s`, não `18s`.

### AC-004: Pergunta pausa o relógio

Given um turn está sendo medido,
When uma pergunta estruturada fica pendente,
Then o cronômetro congela e mostra que aguarda o usuário.

Given a pergunta é respondida ou dispensada,
When nenhuma outra interação humana permanece,
Then o cronômetro retoma do valor congelado.

### AC-005: Esperas sobrepostas

Given um turn tem aprovação e pergunta pendentes em intervalos sobrepostos,
When uma delas é resolvida e a outra continua pendente,
Then o cronômetro continua pausado.

When a última espera é resolvida,
Then o cronômetro retoma sem descontar o intervalo sobreposto duas vezes.

### AC-006–AC-009: Desfechos

Given um turn medido termina com `completed` / `failed` / `blocked` / `cancelled`,
Then o transcript mostra "Completed in Ns" / "Failed after Ns" / "Blocked after
Ns" / "Cancelled after Ns".

### AC-010: Turn sem início observado (Web reload)

Given a Web é recarregada no meio de um turn,
When o snapshot informa que o turn continua ativo,
Then o moon spinner/estado de execução permanece visível sem duração numérica.

### AC-011: Limpeza de recursos

Given um timer está ativo,
When o turn termina, a sessão é trocada ou o componente é desmontado,
Then nenhum intervalo continua executando nem atualizando a interface anterior.

## Error Handling

| Condição | Comportamento |
|---|---|
| `turn.ended` sem `turn.started` observado | Sem entrada de duração |
| `turn.started` duplicado | Ignorar duplicata |
| Novo `turn.started` substitui turn obsoleto | Reset e início novo |
| Aprovação/pergunta chega sem timer ativo | Fluxo normal, sem timer |
| Turn termina durante pausa | Fechar pausa e calcular duração correta |
| Falha de render/tick | Não derrubar UI; próximo render tenta novamente |

## Implementation TODO

### TUI (`apps/kimi-code`)

- [x] Criar `TurnTiming` tracker puro em `src/tui/utils/turn-timing.ts`
- [x] Integrar início/fim ao `SessionEventHandler` (handleTurnBegin / handleTurnEnd)
- [x] Integrar pausa/retomada nos fluxos de approval e question (kimi-tui.ts)
- [x] Timer visual de 1s com label no spinner ou texto para thinking
- [x] Linha final de status no transcript
- [x] Limpeza em fail, troca de sessão e shutdown
- [x] Tests: 7 cenários (completed, cancelled, failed, blocked, sem-start, pausa)

### Web (`apps/kimi-web`)

- [x] Criar `TurnTiming` helper puro em `src/lib/turnTiming.ts`
- [x] Adicionar tipo `TurnOutcome` e campo `outcome` em `AppMessage` / `ChatTurn`
- [x] Integrar início/pausa/fim no `processEvent` em `useKimiWebClient.ts`
- [x] Propagar `outcome` em `messagesToTurns.ts`
- [x] Live timing no placeholder do ChatPane (`Running · 5s`)
- [x] Status + duração no rodapé do turn (`Completed in 25s`)
- [x] i18n en/zh
- [x] Tests: 8 cenários unitários para TurnTiming

## Out of Scope

- `apps/kimi-inspect` e interfaces de debug.
- Mudanças em `agent-core-v2`, `protocol`, `kap-server`, `transcript`,
  `klient` ou `node-sdk`.
- Persistência da duração ativa após reinício/reload ou reconstrução cold.
- Shell local `!`, workflows, subagentes, BTW, background tasks.
- Configuração para esconder o indicador.
