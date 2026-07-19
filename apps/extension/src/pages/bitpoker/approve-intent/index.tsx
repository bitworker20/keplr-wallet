import React, { FunctionComponent, useMemo } from "react";
import { observer } from "mobx-react-lite";
import styled from "styled-components";
import { Stack } from "../../../components/stack";
import { HeaderLayout } from "../../../layouts/header";
import { useStore } from "../../../stores";
import { useInteractionInfo } from "../../../hooks";
import { InteractionWaitingData } from "@keplr-wallet/background";
import { Box } from "../../../components/box";
import { Body2, Subtitle3 } from "../../../components/typography";
import { ColorPalette } from "../../../styles";
import { handleExternalInteractionWithNoProceedNext } from "../../../utils";

const Styles = {
  Container: styled(Stack)`
    height: 100%;
    padding: 0.75rem;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  `,
};

// BitPoker open-game-intent approval. The intent tx LOCKS the stake in the
// pokerchain escrow when it matches, so it is the one session-flow tx gated
// behind an explicit user approval (see BitpokerService.openIntent).
const INTERACTION_TYPE = "bitpoker-open-intent";

// Amounts arrive as uchip (1 CHIP = 1_000_000 uchip) uint64-as-string;
// format without floats.
const formatChip = (uchip: string): string => {
  const digits = uchip.replace(/^0+/, "") || "0";
  if (!/^[0-9]+$/.test(digits)) {
    return `${uchip} uchip`;
  }
  if (digits.length <= 6) {
    const fraction = digits.padStart(6, "0").replace(/0+$/, "");
    return fraction.length === 0 ? "0 CHIP" : `0.${fraction} CHIP`;
  }
  const whole = digits.slice(0, -6);
  const fraction = digits.slice(-6).replace(/0+$/, "");
  return fraction.length === 0 ? `${whole} CHIP` : `${whole}.${fraction} CHIP`;
};

const gameName = (gameType: number): string => {
  switch (gameType) {
    case 2:
      return "ZhaJinHua (three-card brag)";
    case 3:
      return "Texas Hold'em";
    default:
      return `game type ${gameType}`;
  }
};

interface IntentData {
  chainId: string;
  gameType: number;
  minStake: string;
  maxStake: string;
  opponent: string;
  signer: string;
}

export const BitpokerApproveIntentPage: FunctionComponent = observer(() => {
  const { interactionStore } = useStore();

  const reject = () => interactionStore.rejectAll(INTERACTION_TYPE);
  const interactionInfo = useInteractionInfo({
    onWindowClose: reject,
    onUnmount: reject,
  });

  const interactionData: InteractionWaitingData | undefined =
    interactionStore.getAllData(INTERACTION_TYPE)[0];
  const intent = useMemo(
    () => (interactionData?.data ?? undefined) as IntentData | undefined,
    [interactionData?.data]
  );

  const row = (label: string, value: string) => (
    <Box paddingY="0.25rem">
      <Body2 color={ColorPalette["gray-200"]}>{label}</Body2>
      <Subtitle3 style={{ overflowWrap: "anywhere" }}>{value}</Subtitle3>
    </Box>
  );

  return (
    <HeaderLayout
      title="BitPoker — open game intent"
      bottomButtons={[
        {
          text: "Reject",
          color: "secondary",
          size: "large",
          // e2e drivers click by this class (ButtonProps has no testid slot).
          className: "bitpoker-intent-reject",
          onClick: async () => {
            if (!interactionData) {
              return;
            }
            await interactionStore.rejectWithProceedNext(
              interactionData.id,
              (proceedNext) => {
                if (!proceedNext) {
                  handleExternalInteractionWithNoProceedNext();
                }
              }
            );
          },
        },
        {
          text: "Approve",
          color: "primary",
          size: "large",
          className: "bitpoker-intent-approve",
          isLoading: interactionStore.isObsoleteInteraction(
            interactionData?.id
          ),
          onClick: async () => {
            if (!interactionData) {
              return;
            }
            await interactionStore.approveWithProceedNextV2(
              interactionStore.getAllData(INTERACTION_TYPE).map((d) => d.id),
              {},
              (proceedNext) => {
                if (!proceedNext) {
                  handleExternalInteractionWithNoProceedNext();
                }
              }
            );
          },
        },
      ]}
    >
      <Styles.Container>
        {intent ? (
          <React.Fragment>
            {row("Game", gameName(intent.gameType))}
            {row(
              "Stake range",
              `${formatChip(intent.minStake)} – ${formatChip(intent.maxStake)}`
            )}
            {row(
              "Opponent",
              !intent.opponent || intent.opponent === "ANY"
                ? "Anyone (open matchmaking)"
                : intent.opponent
            )}
            {row("Signer", intent.signer)}
            <Box paddingY="0.5rem">
              <Body2 color={ColorPalette["yellow-400"]}>
                When this intent matches, up to {formatChip(intent.maxStake)} is
                locked in the game escrow until the session settles or is
                adjudicated.
              </Body2>
            </Box>
          </React.Fragment>
        ) : (
          <Body2>
            {interactionInfo.interaction
              ? "Loading the pending game intent…"
              : "No pending game intent."}
          </Body2>
        )}
      </Styles.Container>
    </HeaderLayout>
  );
});
